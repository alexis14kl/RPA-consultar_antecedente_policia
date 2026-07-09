const api = (typeof browser !== 'undefined') ? browser : chrome;
const IS_FIREFOX = (typeof browser !== 'undefined') && !!(browser.proxy && browser.proxy.onRequest);

const API_PRIMARY = 'https://apix.hide-my-ip.com';
const API_FALLBACKS = [
  { base: 'https://188.241.60.34', mode: 'direct' },
  { base: 'https://145.14.131.71', mode: 'direct' },
  { base: 'https://185.69.54.240', mode: 'direct' },
  { base: 'https://103.9.78.137', mode: 'direct' },
  { base: 'https://location-list.wendysgolang.workers.dev', mode: 'b64' },
];
const PER_ENTRY_TIMEOUT_MS = 4000;
const STAGGER_MS = 1200;
let preferredApiKey = null;

const EXT_VERSION = (() => { try { return api.runtime.getManifest().version || ''; } catch { return ''; } })();
const DEVICE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
let _deviceId = null;

async function ensureDeviceId() {
  if (_deviceId) return _deviceId;
  const got = (await api.storage.local.get('deviceId')).deviceId;
  if (typeof got === 'string' && /^[A-Za-z0-9]{16}$/.test(got)) { _deviceId = got; return got; }
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  let id = '';
  for (let i = 0; i < 16; i++) id += DEVICE_ID_ALPHABET[buf[i] % DEVICE_ID_ALPHABET.length];
  await api.storage.local.set({ deviceId: id });
  _deviceId = id;
  return id;
}

async function appendIdentity(path, key) {
  if (!key) return path;
  const did = await ensureDeviceId();
  const sep = path.indexOf('?') >= 0 ? '&' : '?';
  return path + `${sep}device_id=${did}&os=chrome&osver=${encodeURIComponent(EXT_VERSION)}`;
}

function buildUrl(entry, path) {
  if (typeof entry === 'string') {
    if (entry === API_PRIMARY) return entry + path;
    return entry + '/?' + btoa(API_PRIMARY + path);
  }
  if (entry.mode === 'direct') return entry.base + path;
  return entry.base + '/?' + btoa(API_PRIMARY + path);
}

function entryKey(entry) {
  return typeof entry === 'string' ? entry : entry.base;
}

function isOkResponse(r) {
  if (r.ok) return true;
  if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) return true;
  return false;
}

function promoteApi(k) {
  if (preferredApiKey !== k) {
    preferredApiKey = k;
    api.storage.local.set({ preferredApi: k });
  }
}

async function fetchApi(path) {
  const entries = [API_PRIMARY, ...API_FALLBACKS];
  const ordered = preferredApiKey
    ? [entries.find(e => entryKey(e) === preferredApiKey), ...entries.filter(e => entryKey(e) !== preferredApiKey)].filter(Boolean)
    : entries.slice();
  return new Promise((resolve, reject) => {
    let winner = null;
    let lastErr = null;
    let launched = 0;
    let settled = 0;
    const ctrls = [];
    const abortAllExcept = (keep) => {
      for (const c of ctrls) if (c !== keep) { try { c.abort(); } catch {} }
    };
    const launchNext = () => {
      if (winner || launched >= ordered.length) return;
      const entry = ordered[launched++];
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      const timer = setTimeout(() => ctrl.abort(), PER_ENTRY_TIMEOUT_MS);
      fetch(buildUrl(entry, path), { signal: ctrl.signal, headers: { 'X-Client-Version': '1' } })
        .then(async (r) => {
          clearTimeout(timer);
          if (winner) return;
          if (!isOkResponse(r)) { lastErr = new Error('HTTP ' + r.status); settled++; checkDone(); return; }
          const body = await r.text();
          if (winner) return;
          if (r.status >= 200 && r.status < 300 && !body.trim()) {
            lastErr = new Error('empty body'); settled++; checkDone(); return;
          }
          winner = entry;
          abortAllExcept(ctrl);
          promoteApi(entryKey(entry));
          resolve(new Response(body, { status: r.status, headers: r.headers }));
        })
        .catch((e) => {
          clearTimeout(timer);
          if (winner) return;
          lastErr = e;
          settled++;
          checkDone();
        });
      if (launched < ordered.length) {
        setTimeout(() => { if (!winner) launchNext(); }, STAGGER_MS);
      }
    };
    const checkDone = () => {
      if (winner) return;
      if (settled >= ordered.length) reject(lastErr || new Error('all entries failed'));
    };
    launchNext();
  });
}

function enableWebRTCLeakPreventing(enable) {
  if (!api.privacy?.network?.webRTCIPHandlingPolicy) return;
  const newVal = enable ? 'disable_non_proxied_udp' : 'default';
  api.privacy.network.webRTCIPHandlingPolicy.get({}, (details) => {
    if (details.levelOfControl === 'controlled_by_this_extension' || details.levelOfControl === 'controllable_by_this_extension') {
      api.privacy.network.webRTCIPHandlingPolicy.set({ value: newVal });
    }
  });
}

let cachedAuth = {};
let currentProxyInfo = null;
const AUTH_MAP_CAP = 10;

function normalizeAuth(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out = {};
  for (const k of Object.keys(v)) {
    if (typeof v[k] === 'string' && v[k].length >= 32) out[k] = v[k];
  }
  return out;
}

let _updateLocationsInFlight = null;
async function updateLocationsFromAPI(keyOverride) {
  if (keyOverride !== undefined) return _doUpdateLocationsFromAPI(keyOverride);
  if (_updateLocationsInFlight) return _updateLocationsInFlight;
  _updateLocationsInFlight = _doUpdateLocationsFromAPI(keyOverride).finally(() => { _updateLocationsInFlight = null; });
  return _updateLocationsInFlight;
}

async function fetchJsonResilient(path) {
  const r = await fetchApi(path);
  return JSON.parse((await r.text()).trim());
}

let _fetchEpoch = 0;

async function _revertPendingExtra() {
  const { extraLocations: cur } = await api.storage.local.get('extraLocations');
  if (Array.isArray(cur) && cur.some(x => x && x.ip === '__pending__')) {
    const reverted = cur.map(x => (x && x.ip === '__pending__') ? { ...x, ip: '' } : x);
    await api.storage.local.set({ extraLocations: reverted });
  }
}

async function _doUpdateLocationsFromAPI(keyOverride) {
  const myEpoch = ++_fetchEpoch;
  const key = (keyOverride === undefined) ? (await api.storage.local.get('key')).key : (keyOverride || '');
  let path = '/?action=servers&client=proxy' + (key ? `&key=${encodeURIComponent(key)}` : '');
  path = await appendIdentity(path, key);
  try {
    const data = await fetchJsonResilient(path);
    if (myEpoch !== _fetchEpoch) return false;
    const servers = data.servers || [];
    if (!servers.length) {
      await _revertPendingExtra();
      await api.storage.local.set({ lastFetchError: 'empty', lastFetchAt: Date.now() });
      return false;
    }
    const locations = [];
    const extraLocations = [];
    for (const s of servers) {
      const entry = {
        location: `${s.city || ''},,${s.country_code || ''},${s.country || ''}`,
        ip: s.ip || '',
        port: s.port || 5598,
        country: s.country_code || '',
        countryname: s.country || '',
      };
      if (s.level === 0 && s.ip) locations.push(entry);
      else extraLocations.push(entry);
    }
    if (myEpoch !== _fetchEpoch) return false;
    await api.storage.local.set({ proxyLocations: locations, extraLocations, lastFetchError: null, lastFetchAt: Date.now() });
    const { recentLocations = [] } = await api.storage.local.get('recentLocations');
    const filtered = recentLocations.filter(l => Number(l.port) === 5598);
    await api.storage.local.set({ recentLocations: filtered });
    return true;
  } catch (e) {
    console.error('updateLocationsFromAPI:', e);
    if (myEpoch === _fetchEpoch) {
      await _revertPendingExtra();
      await api.storage.local.set({ lastFetchError: String(e && e.message || e || 'fetch failed'), lastFetchAt: Date.now() });
    }
    return false;
  }
}

api.runtime.onInstalled.addListener((details) => {
  if (details && details.reason === 'update') {
    cachedAuth = {};
    currentProxyInfo = null;
    api.storage.local.remove(['lastauth', 'currentProxy', 'currentProxyActive']);
    if (!IS_FIREFOX && api.proxy && api.proxy.settings) {
      api.proxy.settings.clear({ scope: 'regular' });
    }
  } else {
    api.storage.local.remove('currentProxy');
  }
  api.storage.local.get(['preventipleak'], (r) => {
    if (typeof r.preventipleak === 'undefined') {
      api.storage.local.set({ preventipleak: '1' });
      enableWebRTCLeakPreventing(true);
    } else if (r.preventipleak === '1') {
      enableWebRTCLeakPreventing(true);
    }
  });
  api.storage.local.set({ lastUpdateTimestamp: 0 });
  updateLocationsFromAPI();
  setIconBadgeIfProxy();
});

api.runtime.onStartup.addListener(() => {
  setIconBadgeIfProxy();
});

async function setIconBadgeIfProxy() {
  try {
    if (IS_FIREFOX) {
      const { currentProxy, lastCountry } = await api.storage.local.get(['currentProxy', 'lastCountry']);
      if (!currentProxy || !lastCountry) return;
      applyIconBadge(lastCountry);
      return;
    }
    api.proxy.settings.get({ incognito: false }, (config) => {
      if (config.value.mode !== 'fixed_servers') return;
      api.storage.local.get('lastCountry', (result) => {
        if (typeof result.lastCountry === 'string' && result.lastCountry.length === 2) applyIconBadge(result.lastCountry);
      });
    });
  } catch {}
}

function applyIconBadge(cc) {
  const code = cc.trim().toUpperCase();
  const flagUrl = `img/flags/${code}.png`;
  try {
    api.action.setIcon({ path: flagUrl }, () => {
      if (api.runtime.lastError) {
        api.action.setIcon({ path: 'img/default_icon.png' });
      }
    });
  } catch {
    api.action.setIcon({ path: 'img/default_icon.png' });
  }
  api.action.setBadgeText({ text: code });
  try { api.action.setBadgeBackgroundColor({ color: '#1a1a1a' }); } catch {}
  if (api.action.setBadgeTextColor) {
    try { api.action.setBadgeTextColor({ color: '#FFFFFF' }); } catch {}
  }
}

let killSwitchEnabled = true;
const hydrated = new Promise(resolve => {
  api.storage.local.get(['lastauth', 'currentProxy', 'preferredApi', 'killSwitch'], r => {
    if (r) {
      cachedAuth = normalizeAuth(r.lastauth);
      if (r.currentProxy) currentProxyInfo = r.currentProxy;
      if (r.preferredApi) preferredApiKey = r.preferredApi;
      killSwitchEnabled = r.killSwitch !== false;
    }
    resolve();
  });
});
api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lastauth) cachedAuth = normalizeAuth(changes.lastauth.newValue);
  if (changes.currentProxy) currentProxyInfo = changes.currentProxy.newValue || null;
  if (changes.preferredApi) preferredApiKey = changes.preferredApi.newValue || null;
  if (changes.killSwitch) killSwitchEnabled = changes.killSwitch.newValue !== false;
});

const PROXY_ERR_RE = /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH/;
const KILL_WINDOW_MS = 30000;
const KILL_THRESHOLD = 5;
let proxyErrorTs = [];

function triggerKillSwitch() {
  const ip = currentProxyInfo && currentProxyInfo.ip;
  proxyErrorTs = [];
  api.storage.local.get(['currentProxy', 'lastCountry'], (r) => {
    const country = (r && r.currentProxy && r.currentProxy.countryname) || (r && r.lastCountry) || '';
    api.storage.local.set({
      killed: true,
      killedAt: Date.now(),
      killedCountry: country,
      killedIp: ip || '',
    });
    if (!IS_FIREFOX && api.proxy && api.proxy.settings) {
      const blackhole = {
        mode: 'fixed_servers',
        rules: {
          singleProxy: { scheme: 'http', host: '127.0.0.1', port: 1 },
          bypassList: BYPASS_HOSTS,
        },
      };
      api.proxy.settings.set({ value: blackhole, scope: 'regular' }, () => {
        if (api.runtime.lastError) {
          api.storage.local.set({ killedFailedToBlock: true });
        }
      });
    } else if (IS_FIREFOX) {
      currentProxyInfo = { ip: '127.0.0.1', port: 1, scheme: 'http', killed: true };
      api.storage.local.set({ currentProxyActive: currentProxyInfo, currentProxy: null });
    }
    if (!IS_FIREFOX) {
      currentProxyInfo = null;
      api.storage.local.set({ currentProxy: null });
    }
    api.action.setIcon({ path: 'img/disabled.png' });
    api.action.setBadgeBackgroundColor({ color: '#cc3333' });
    api.action.setBadgeText({ text: '!' });
  });
}

if (api.webRequest && api.webRequest.onErrorOccurred) {
  api.webRequest.onErrorOccurred.addListener((details) => {
    if (!killSwitchEnabled || !currentProxyInfo) return;
    if (!details || !details.error || !PROXY_ERR_RE.test(details.error)) return;
    const now = Date.now();
    proxyErrorTs.push(now);
    proxyErrorTs = proxyErrorTs.filter(t => now - t < KILL_WINDOW_MS);
    if (proxyErrorTs.length >= KILL_THRESHOLD) triggerKillSwitch();
  }, { urls: ['<all_urls>'] });
}

function trimAuthMap(map) {
  const keys = Object.keys(map);
  if (keys.length <= AUTH_MAP_CAP) return map;
  const out = {};
  for (const k of keys.slice(-AUTH_MAP_CAP)) out[k] = map[k];
  return out;
}

const _authInFlight = new Map();
const _lastRefreshAt = new Map();
const REFRESH_COOLDOWN_MS = 60000;

async function _fetchProxyAuthRaw(ip) {
  const { key } = await api.storage.local.get('key');
  let path = `/?action=proxyauth&ip=${encodeURIComponent(ip)}`;
  if (key) path += `&key=${encodeURIComponent(key)}`;
  path = await appendIdentity(path, key);
  const r = await fetchApi(path);
  if (r.status === 429) throw new Error('proxyauth rate limited');
  const cred = (await r.text()).trim();
  if (!cred || cred === 'ERR' || !/^[0-9a-f]{40,}$/i.test(cred)) throw new Error('proxyauth ERR');
  return cred;
}

function fetchProxyAuth(ip) {
  const inflight = _authInFlight.get(ip);
  if (inflight) return inflight;
  const p = _fetchProxyAuthRaw(ip).finally(() => {
    if (_authInFlight.get(ip) === p) _authInFlight.delete(ip);
  });
  _authInFlight.set(ip, p);
  return p;
}

async function storeCred(ip, cred) {
  const cur = normalizeAuth((await api.storage.local.get('lastauth')).lastauth);
  const next = trimAuthMap({ ...cur, [ip]: cred });
  cachedAuth = next;
  await api.storage.local.set({ lastauth: next });
}

async function setProxyBrowser(ip, port) {
  try {
    if (cachedAuth && cachedAuth[ip]) return true;
    const cred = await fetchProxyAuth(ip);
    await storeCred(ip, cred);
    return true;
  } catch (e) {
    console.error('proxyauth:', e);
    return false;
  }
}

async function refreshAuthForIp(ip) {
  const last = _lastRefreshAt.get(ip) || 0;
  if (Date.now() - last < REFRESH_COOLDOWN_MS) {
    return (cachedAuth && cachedAuth[ip]) || null;
  }
  _lastRefreshAt.set(ip, Date.now());
  try {
    const cred = await fetchProxyAuth(ip);
    await storeCred(ip, cred);
    return cred;
  } catch {
    return null;
  }
}

const BYPASS_HOSTS = (() => {
  const hosts = [new URL(API_PRIMARY).hostname];
  for (const e of API_FALLBACKS) {
    try { hosts.push(new URL(e.base).hostname); } catch {}
  }
  return [...new Set(hosts)];
})();

async function applyProxy(ip, port, scheme) {
  proxyErrorTs = [];
  api.storage.local.remove(['killed', 'killedAt', 'killedCountry', 'killedIp']);
  try { api.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] }); } catch {}
  if (IS_FIREFOX) {
    currentProxyInfo = { ip, port, scheme };
    await api.storage.local.set({ currentProxyActive: currentProxyInfo });
    return { ok: true };
  }
  const config = {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme, host: ip, port },
      bypassList: BYPASS_HOSTS,
    },
  };
  const clearErr = await new Promise((res) => {
    api.proxy.settings.clear({ scope: 'regular' }, () => res(api.runtime.lastError));
  });
  if (clearErr && !/no setting to clear/i.test(clearErr.message || '')) {
    return { ok: false, reason: 'controlled', message: clearErr.message || 'proxy controlled by another extension' };
  }
  const setErr = await new Promise((res) => {
    api.proxy.settings.set({ value: config, scope: 'regular' }, () => res(api.runtime.lastError));
  });
  if (setErr) {
    return { ok: false, reason: 'controlled', message: setErr.message || 'proxy controlled by another extension' };
  }
  const got = await new Promise((res) => {
    api.proxy.settings.get({ incognito: false }, (cfg) => res(cfg));
  });
  if (!got || got.levelOfControl !== 'controlled_by_this_extension') {
    return { ok: false, reason: 'controlled', message: 'proxy.settings is controlled by ' + (got && got.levelOfControl) };
  }
  const v = got.value || {};
  const sp = v.rules && v.rules.singleProxy;
  if (v.mode !== 'fixed_servers' || !sp || sp.host !== ip || Number(sp.port) !== Number(port)) {
    return { ok: false, reason: 'mismatch', message: 'proxy config did not apply' };
  }
  return { ok: true };
}

const PROBE_HOSTS = [
  'https://api.ipify.org/',
  'https://ipv4.icanhazip.com/',
  'https://checkip.amazonaws.com/',
  'https://ifconfig.me/ip',
  'https://ident.me/',
];
const PROBE_FILTERS = PROBE_HOSTS.map(u => {
  try { return new URL(u).origin + '/*'; } catch { return null; }
}).filter(Boolean);

function probeOne(host, proxyIp, perTryMs) {
  return new Promise((resolve) => {
    const cb = '_=' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const url = host + (host.includes('?') ? '&' : '?') + cb;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { api.webRequest.onCompleted.removeListener(onComplete); } catch {}
      try { api.webRequest.onErrorOccurred.removeListener(onErr); } catch {}
      clearTimeout(timer);
      resolve(r);
    };
    const onComplete = (details) => {
      if (details.url !== url) return;
      const observedIp = details.ip || null;
      finish({ ok: true, observedIp, source: url });
    };
    const onErr = (details) => {
      if (details.url !== url) return;
      finish({ ok: false, error: details.error || 'request error' });
    };
    api.webRequest.onCompleted.addListener(onComplete, { urls: PROBE_FILTERS });
    api.webRequest.onErrorOccurred.addListener(onErr, { urls: PROBE_FILTERS });
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), perTryMs);
    fetch(url, { method: 'GET', cache: 'no-store' }).catch(() => {});
  });
}

async function probeProxy(proxyIp, totalBudgetMs) {
  if (IS_FIREFOX) return { ok: true, viaProxy: true, observedIp: null, skipped: 'firefox' };
  const total = totalBudgetMs || 6000;
  const perTry = Math.max(1500, Math.floor(total / PROBE_HOSTS.length));
  const start = Date.now();
  let lastErr = null;
  let nullIpCount = 0;
  for (const host of PROBE_HOSTS) {
    const remaining = total - (Date.now() - start);
    if (remaining <= 500) break;
    const r = await probeOne(host, proxyIp, Math.min(perTry, remaining));
    if (r.ok) {
      if (!r.observedIp) {
        nullIpCount++;
        lastErr = 'no ip in webRequest details';
        continue;
      }
      const viaProxy = r.observedIp === proxyIp;
      return { ok: true, viaProxy, observedIp: r.observedIp, source: r.source };
    }
    lastErr = r.error;
  }
  if (nullIpCount > 0) return { ok: true, viaProxy: true, observedIp: null, source: 'inconclusive' };
  return { ok: false, error: lastErr || 'all probes failed', observedIp: null };
}

async function clearProxyConfig() {
  proxyErrorTs = [];
  try { api.action.setIcon({ path: 'img/disabled.png' }); } catch {}
  try { api.action.setBadgeText({ text: '' }); } catch {}
  if (IS_FIREFOX) {
    currentProxyInfo = null;
    await api.storage.local.set({ currentProxyActive: null });
    return;
  }
  api.proxy.settings.clear({ scope: 'regular' });
}

if (IS_FIREFOX && api.proxy && api.proxy.onRequest) {
  api.storage.local.get('currentProxyActive', (r) => {
    if (r && r.currentProxyActive) currentProxyInfo = r.currentProxyActive;
  });
  api.proxy.onRequest.addListener((details) => {
    if (!currentProxyInfo || !currentProxyInfo.ip) return { type: 'direct' };
    try {
      const host = new URL(details.url).hostname;
      if (BYPASS_HOSTS.some(h => host === h || host.endsWith('.' + h))) return { type: 'direct' };
    } catch {}
    return {
      type: currentProxyInfo.scheme === 'http' ? 'http' : (currentProxyInfo.scheme || 'http'),
      host: currentProxyInfo.ip,
      port: Number(currentProxyInfo.port),
    };
  }, { urls: ['<all_urls>'] });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateProxy') {
    setProxyBrowser(message.ip, message.port).then(ok => sendResponse({ status: ok ? 'success' : 'error' }));
    return true;
  } else if (message.type === 'applyProxy') {
    applyProxy(message.ip, Number(message.port), message.scheme).then(res => sendResponse({
      status: res.ok ? 'success' : 'error',
      reason: res.reason || null,
      message: res.message || null,
    }));
    return true;
  } else if (message.type === 'clearProxy') {
    clearProxyConfig().then(() => sendResponse({ status: 'success' }));
    return true;
  } else if (message.type === 'updateLocationsFromAPI') {
    updateLocationsFromAPI('key' in message ? message.key : undefined).then(ok => sendResponse({ status: ok ? 'success' : 'error' }));
    return true;
  } else if (message.type === 'updatePreventLeak') {
    enableWebRTCLeakPreventing(message.enable);
    sendResponse({ status: 'success' });
  } else if (message.type === 'setConnectedIcon') {
    const cc = (message.country || '').trim().toUpperCase();
    if (cc && cc.length === 2) {
      try { api.action.setBadgeBackgroundColor({ color: [0, 0, 0, 0] }); } catch {}
      applyIconBadge(cc);
    }
    sendResponse({ ok: true });
    return true;
  } else if (message.type === 'checkMyIp') {
    (async () => {
      const total = 8000;
      const perTry = 3000;
      const start = Date.now();
      for (const host of PROBE_HOSTS) {
        const remaining = total - (Date.now() - start);
        if (remaining <= 500) break;
        const r = await probeOne(host, '', Math.min(perTry, remaining));
        if (r.ok && r.observedIp) {
          sendResponse({ ok: true, ip: r.observedIp });
          return;
        }
      }
      sendResponse({ ok: false, error: 'all probes failed' });
    })();
    return true;
  } else if (message.type === 'verifyEgress') {
    (async () => {
      const proxyIp = (message.proxyIp || (currentProxyInfo && currentProxyInfo.ip) || '').trim();
      if (!proxyIp) { sendResponse({ ok: false, error: 'no proxy ip' }); return; }
      const r = await probeProxy(proxyIp, 6000);
      sendResponse({ ok: r.ok && r.viaProxy === true, leak: r.ok && r.viaProxy === false, observedIp: r.observedIp, error: r.error || null });
    })();
    return true;
  } else if (message.type === 'apiFetch') {
    (async () => {
      try {
        const r = await fetchApi(message.path);
        const body = await r.text();
        sendResponse({ ok: true, status: r.status, body });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

const authAttempts = new Map();
const AUTH_ATTEMPT_TTL = 30 * 1000;
const AUTH_ATTEMPT_CAP = 200;

function authKey(details) {
  return `${details.requestId || ''}|${(details.challenger && details.challenger.host) || ''}`;
}

function recordAttempt(k) {
  const now = Date.now();
  for (const [key, v] of authAttempts) {
    if (now - v.ts > AUTH_ATTEMPT_TTL) authAttempts.delete(key);
  }
  while (authAttempts.size >= AUTH_ATTEMPT_CAP) {
    const oldest = authAttempts.keys().next().value;
    if (oldest === undefined) break;
    authAttempts.delete(oldest);
  }
  const cur = authAttempts.get(k);
  const n = (cur ? cur.count : 0) + 1;
  authAttempts.set(k, { count: n, ts: now });
  return n;
}

async function resolveCredForProxy(details) {
  const host = (details.challenger && details.challenger.host) || (currentProxyInfo && currentProxyInfo.ip) || null;
  if (!host) return null;
  if (cachedAuth && cachedAuth[host]) return cachedAuth[host];
  const r = await api.storage.local.get('lastauth');
  const map = normalizeAuth(r && r.lastauth);
  if (map[host]) {
    cachedAuth = map;
    return map[host];
  }
  return null;
}

const onAuthRequiredHandler = async (details) => {
  if (details.isProxy !== true) return {};
  await hydrated;
  const k = authKey(details);
  const attempt = recordAttempt(k);
  const host = (details.challenger && details.challenger.host) || (currentProxyInfo && currentProxyInfo.ip) || null;

  if (attempt >= 3) {
    authAttempts.delete(k);
    return { cancel: true };
  }

  let cred = await resolveCredForProxy(details);

  if (attempt >= 2 && host) {
    cred = await refreshAuthForIp(host);
  }

  if (!cred) return { cancel: true };
  return { authCredentials: { username: cred, password: cred } };
};

const authExtra = IS_FIREFOX ? ['blocking'] : ['asyncBlocking'];
if (IS_FIREFOX) {
  api.webRequest.onAuthRequired.addListener(
    (details) => onAuthRequiredHandler(details),
    { urls: ['<all_urls>'] },
    authExtra
  );
} else {
  api.webRequest.onAuthRequired.addListener(
    (details, callback) => { onAuthRequiredHandler(details).then(callback); },
    { urls: ['<all_urls>'] },
    authExtra
  );
}

// ============================================================================
// AUTO-CONNECT (parche RPA): la extensión se conecta sola al arrancar, igual
// que Buster resuelve solo. Replica la secuencia del popup setProxy():
//   updateProxy (fetch auth) -> applyProxy (chrome.proxy.settings) -> verify.
// Config vía chrome.storage.local: { autoConnect:true/false, autoConnectCC:'US' }
// o por defecto abajo. Puerto 5598 => http (proxies free de hide-my-ip).
// ============================================================================
const AUTO_CONNECT_DEFAULT = true;
const AUTO_CONNECT_DEFAULT_CC = '';      // '' = cualquiera; ej 'US','ES','CO'
const AUTO_CONNECT_MAX_TRIES = 8;

async function _autoCfg() {
  const r = await api.storage.local.get(['autoConnect', 'autoConnectCC']);
  return {
    enabled: (typeof r.autoConnect === 'boolean') ? r.autoConnect : AUTO_CONNECT_DEFAULT,
    cc: (typeof r.autoConnectCC === 'string') ? r.autoConnectCC : AUTO_CONNECT_DEFAULT_CC,
  };
}

async function _autoPickCandidates(preferredCC) {
  let { proxyLocations = [] } = await api.storage.local.get('proxyLocations');
  if (!proxyLocations.length) {
    await updateLocationsFromAPI();
    ({ proxyLocations = [] } = await api.storage.local.get('proxyLocations'));
  }
  let cands = proxyLocations.filter(s => s && s.ip && Number(s.port) === 5598);
  if (!cands.length) cands = proxyLocations.filter(s => s && s.ip);
  if (preferredCC) {
    const pc = cands.filter(s => String(s.country || '').toUpperCase() === preferredCC.toUpperCase());
    if (pc.length) cands = pc;
  }
  return cands;
}

let _autoConnectInFlight = null;
async function autoConnect(preferredCCArg) {
  if (_autoConnectInFlight) return _autoConnectInFlight;
  _autoConnectInFlight = (async () => {
    await hydrated;
    const cfg = await _autoCfg();
    if (!cfg.enabled) return false;
    const preferredCC = (preferredCCArg !== undefined) ? preferredCCArg : cfg.cc;
    // ¿ya conectado?
    try {
      const cur = await new Promise(r => api.proxy.settings.get({ incognito: false }, r));
      if (cur && cur.value && cur.value.mode === 'fixed_servers' && currentProxyInfo) {
        console.log('[autoConnect] ya conectado a', currentProxyInfo.ip);
        return true;
      }
    } catch {}
    const cands = await _autoPickCandidates(preferredCC);
    if (!cands.length) { console.warn('[autoConnect] sin servidores disponibles'); return false; }
    for (const s of cands.slice(0, AUTO_CONNECT_MAX_TRIES)) {
      const ip = s.ip;
      const port = Number(s.port) || 5598;
      const scheme = port === 5598 ? 'http' : 'socks5';
      try {
        const authOk = await setProxyBrowser(ip, port);     // = msg updateProxy
        if (!authOk) { console.warn('[autoConnect] auth falló', ip); continue; }
        const res = await applyProxy(ip, port, scheme);      // = msg applyProxy
        if (!res.ok) { console.warn('[autoConnect] applyProxy falló', ip, res.message); continue; }
        currentProxyInfo = { ip, port, scheme };
        const cc = String(s.country || '').toUpperCase();
        const sel = { location: s.location, ip, port, country: s.country, countryname: s.countryname };
        await api.storage.local.set({ currentProxy: sel, lastProxy: sel, lastCountry: cc });
        const verify = await probeProxy(ip, 6000);
        if (verify.ok && verify.viaProxy) {
          try { if (cc.length === 2) applyIconBadge(cc); } catch {}
          console.log('[autoConnect] CONECTADO', ip + ':' + port, cc || '');
          return true;
        }
        console.warn('[autoConnect] verify falló (leak/observed=' + (verify.observedIp||'?') + '), probando otro');
        await clearProxyConfig();
        currentProxyInfo = null;
      } catch (e) {
        console.warn('[autoConnect] excepción', ip, e && e.message);
        try { await clearProxyConfig(); } catch {}
        currentProxyInfo = null;
      }
    }
    console.warn('[autoConnect] no se pudo conectar a ningún servidor');
    return false;
  })().finally(() => { _autoConnectInFlight = null; });
  return _autoConnectInFlight;
}

// Disparadores: arranque del navegador, instalación, y cold-start del SW.
api.runtime.onStartup.addListener(() => { autoConnect(); });
api.runtime.onInstalled.addListener(() => { setTimeout(() => autoConnect(), 1500); });
(async () => {
  await hydrated;
  try {
    const cur = await new Promise(r => api.proxy.settings.get({ incognito: false }, r));
    if (!cur || !cur.value || cur.value.mode !== 'fixed_servers') autoConnect();
  } catch { autoConnect(); }
})();
// Reintento periódico por si el kill-switch o un fallo dejó sin proxy.
setInterval(() => { if (!currentProxyInfo) autoConnect(); }, 60000);
