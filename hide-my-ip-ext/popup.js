const allContainer = document.getElementById('all-locations');
const UPDATE_INTERVAL = 60 * 60 * 1000;
const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
const IS_FIREFOX = (typeof browser !== 'undefined') && !!(browser.proxy && browser.proxy.onRequest);
let messages = {};

function apiFetch(path) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('apiFetch timeout')); } }, 30000);
    browserAPI.runtime.sendMessage({ type: 'apiFetch', path }, (resp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!resp || !resp.ok) return reject(new Error((resp && resp.error) || 'fetch failed'));
      resolve({ ok: true, status: resp.status, text: () => Promise.resolve(resp.body), json: () => Promise.resolve(JSON.parse(resp.body)) });
    });
  });
}

function show(el, visible = true) {
  if (!el) return;
  if (visible) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

let setProxyEpoch = 0;

document.addEventListener('DOMContentLoaded', () => {
  checkAndUpdateLocations(false);
  browserAPI.storage.local.get(['proxyLocations', 'extraLocations', 'recentLocations', 'currentProxy', 'key', 'preventipleak', 'killSwitch', 'killed', 'killedAt', 'killedCountry'], (data) => {
    let { proxyLocations = [], extraLocations = [], recentLocations = [], currentProxy, key, preventipleak, killSwitch, killed, killedAt, killedCountry } = data;
    const recentContainer = document.getElementById('recent-locations');
    const toastEl = document.getElementById('toast');
    const statusRow = document.getElementById('proxy-status-container');
    const statusMeta = document.getElementById('proxy-status-meta');
    const proxyStatusToggle = document.getElementById('proxy-status-toggle');
    const proxyStatusText = document.getElementById('proxy-status-text');
    const proxyStatusFlag = document.getElementById('proxy-status-flag');
    const recentLocationsHeader = document.getElementById('recentlocations');
    const preventLeakCheckbox = document.getElementById('checkbox1');
    const footerMain = document.getElementById('footer-main');
    const footerEl = document.getElementById('footer');
    const stateLocked = document.getElementById('license-state-locked');
    const popoverLicense = document.getElementById('popover-license');
    const popoverLicenseFree = document.getElementById('popover-license-free');
    const btnUnlock = document.getElementById('btn_unlock');
    const btnBuy = document.getElementById('btn_buy');
    const btnRemove = document.getElementById('btn_remove_license');
    const btnChangeLicense = document.getElementById('btn_change_license');
    const btnEnterLicenseMenu = document.getElementById('btn_enter_license_menu');
    const enterCodeDiv = document.getElementById('enter-code-div');
    const textareaKey = document.getElementById('textarea_key');
    const sanitizeKey = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 29);
    textareaKey.addEventListener('input', () => {
      const cleaned = sanitizeKey(textareaKey.value);
      if (cleaned !== textareaKey.value) {
        const pos = Math.min(textareaKey.selectionStart || 0, cleaned.length);
        textareaKey.value = cleaned;
        try { textareaKey.setSelectionRange(pos, pos); } catch {}
      }
    });
    textareaKey.addEventListener('paste', (e) => {
      e.preventDefault();
      const txt = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      textareaKey.value = sanitizeKey(txt);
    });
    const btnBack = document.getElementById('btn_back');
    const btnEnterCodeSubmit = document.getElementById('btn_enterkey');
    const bannerEl = document.getElementById('banner');
    const bannerMsgEl = document.getElementById('banner-msg');
    const bannerCloseEl = document.getElementById('banner-close');

    let toastTimer;
    let activePremiumHint = null;

    function renderLicenseState() {
      const hasKey = typeof key === 'string' && key.length === 29;
      show(enterCodeDiv, false);
      show(stateLocked, !hasKey);
      show(footerMain, !hasKey);
      show(footerEl, !hasKey);
      show(popoverLicense, hasKey);
      show(popoverLicenseFree, !hasKey);
    }

    function showBanner(text, sticky) {
      bannerMsgEl.textContent = text;
      show(bannerEl, true);
      if (!sticky) setTimeout(() => show(bannerEl, false), 4000);
    }
    bannerCloseEl.addEventListener('click', () => show(bannerEl, false));
    bannerCloseEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(bannerEl, false); } });

    function openKeyPanel() {
      show(footerEl, true);
      show(footerMain, false);
      show(enterCodeDiv, true);
      show(settingsPopover, false);
      if (btnSettings) btnSettings.setAttribute('aria-expanded', 'false');
      textareaKey.value = (typeof key === 'string' && key.length === 29) ? key : '';
      textareaKey.focus();
    }

    function closeKeyPanel() {
      show(enterCodeDiv, false);
      renderLicenseState();
    }

    function removePremiumHint() {
      if (activePremiumHint) { activePremiumHint.remove(); activePremiumHint = null; }
    }

    function showPremiumHint(rowEl) {
      removePremiumHint();
      const hint = document.createElement('div');
      hint.className = 'premium-hint';
      const text = document.createElement('span');
      text.className = 'hint-text';
      text.textContent = getTranslatedMessage('please_upgrade_msg') || 'Premium location — upgrade to unlock';
      const cta = document.createElement('button');
      cta.type = 'button';
      cta.className = 'hint-cta';
      cta.textContent = 'Upgrade';
      cta.addEventListener('click', (e) => {
        e.stopPropagation();
        browserAPI.tabs.create({ url: 'https://www.hidemyip.com/#pricing' });
      });
      hint.append(text, cta);
      rowEl.insertAdjacentElement('afterend', hint);
      activePremiumHint = hint;
      setTimeout(() => { if (activePremiumHint === hint) removePremiumHint(); }, 6000);
    }

    function buildLocationItem(loc) {
      const { location, ip, port, country, countryname } = loc;
      const [city, state] = (location || '').split(',');
      const flagUrl = `img/flags/${(country || '').trim().toUpperCase() || 'placeholder'}.png`;
      const isPending = ip === '__pending__';
      const isPremium = !ip;
      const isSelected = !!(currentProxy && ip && currentProxy.ip === ip && Number(currentProxy.port) === Number(port));
      const item = document.createElement('div');
      item.className = `menu-item ${isPremium ? 'premium-proxy' : 'free-proxy'}${isSelected ? ' selected' : ''}`;
      if (isPremium) item.setAttribute('aria-disabled', 'true');

      const sub = document.createElement('span');
      sub.className = 'menu-item-subitem';
      sub.dataset.ip = ip || '';
      sub.dataset.port = port;
      sub.dataset.country = country || '';
      sub.dataset.countryname = countryname || '';
      sub.dataset.location = location || '';
      if (isSelected) sub.dataset.selected = 'true';

      const flag = document.createElement('span');
      flag.className = 'menu-flag';
      flag.style.backgroundImage = `url('${flagUrl}')`;

      const text = document.createElement('span');
      text.className = 'menu-item-text';
      text.textContent = [countryname, state, city].filter(Boolean).join(', ');

      const iconActive = document.createElement('i');
      iconActive.className = 'toggle-button-active fa fa-check';
      iconActive.style.display = isSelected ? 'block' : 'none';
      const iconOff = document.createElement('i');
      iconOff.className = 'toggle-button-turn-off fa fa-times';
      iconOff.style.display = 'none';

      sub.append(flag, text, iconActive, iconOff);

      if (isPremium) {
        const lock = document.createElement('i');
        lock.className = 'toggle-lock fa fa-lock';
        lock.setAttribute('aria-hidden', 'true');
        sub.appendChild(lock);
        const sr = document.createElement('span');
        sr.className = 'sr-only';
        sr.textContent = ', premium, upgrade required';
        text.appendChild(sr);
      }

      item.appendChild(sub);

      sub.addEventListener('click', () => {
        if (isPending) {
          setToast('Loading servers — try again in a moment.', false, 'loading_servers_msg');
          checkAndUpdateLocations(true);
          return;
        }
        if (isPremium) { showPremiumHint(item); return; }
        removePremiumHint();
        if (sub.dataset.selected === 'true') { clearProxy(); return; }
        setProxy(ip, port, country, countryname, location);
      });
      sub.addEventListener('mouseenter', () => {
        if (sub.dataset.selected === 'true') {
          iconActive.style.display = 'none';
          iconOff.style.display = 'block';
        }
      });
      sub.addEventListener('mouseleave', () => {
        if (sub.dataset.selected === 'true') {
          iconActive.style.display = 'block';
          iconOff.style.display = 'none';
        }
      });
      return item;
    }

    function displayLocations(locations, container) {
      if (!locations || !container) return;
      container.replaceChildren(...locations.map(buildLocationItem));
    }

    function updateRecentLocations(selected) {
      const exists = recentLocations.some(l => l.ip === selected.ip && l.port === selected.port);
      if (exists) return;
      if (recentLocations.length === 3) recentLocations.shift();
      recentLocations.push(selected);
      browserAPI.storage.local.set({ recentLocations });
      displayLocations(recentLocations.slice().reverse(), recentContainer);
      toggleRecentLocationsHeader(recentLocations);
    }

    function updateCurrentProxy(selected) {
      currentProxy = selected;
      browserAPI.storage.local.set({ currentProxy: selected, lastProxy: selected });
      displayLocations(recentLocations, recentContainer);
    }

    function tryAuth(ip, portNumber) {
      return new Promise(resolve => {
        browserAPI.runtime.sendMessage({ type: 'updateProxy', ip, port: portNumber }, (response) => {
          resolve(!!(response && response.status === 'success'));
        });
      });
    }

    function applyProxyMsg(ip, port, scheme) {
      return new Promise(resolve => {
        browserAPI.runtime.sendMessage({ type: 'applyProxy', ip, port, scheme }, (response) => {
          resolve(response || { status: 'error', reason: 'no-response' });
        });
      });
    }

    function verifyEgress(proxyIp) {
      return new Promise(resolve => {
        const t = setTimeout(() => resolve({ ok: false, error: 'timeout' }), 12000);
        browserAPI.runtime.sendMessage({ type: 'verifyEgress', proxyIp }, (response) => {
          clearTimeout(t);
          resolve(response || { ok: false, error: 'no-response' });
        });
      });
    }

    async function setProxy(ip, port, country, countryname, location) {
      const portNumber = parseInt(port, 10);
      const scheme = (portNumber === 5598) ? 'http' : 'socks5';
      statusRow.classList.remove('connected');
      statusRow.classList.add('connecting');
      statusMeta.textContent = getTranslatedMessage('connecting_msg') || 'Connecting...';
      const [pendingCity, pendingState] = (location || '').split(',');
      let pendingFull = [countryname, pendingState, pendingCity].filter(Boolean).join(', ');
      if (pendingFull.length > 34) pendingFull = [countryname, pendingCity].filter(Boolean).join(', ');
      proxyStatusText.textContent = pendingFull;
      proxyStatusFlag.classList.remove('no-flag');
      proxyStatusFlag.style.backgroundImage = `url('img/flags/${(country || '').trim().toUpperCase() || 'placeholder'}.png')`;
      if (scheme === 'socks5') browserAPI.storage.local.remove('lastauth');

      const myEpoch = ++setProxyEpoch;
      const stale = () => setProxyEpoch !== myEpoch;
      const name = pendingFull || countryname || (getTranslatedMessage('this_location_label') || 'this location');

      // Only ever connect to the location the user picked. If it fails we show
      // a clear error naming it — we never silently switch to another location.
      const fail = (reasonTag) => {
        if (stale()) return;
        statusRow.classList.remove('connecting');
        browserAPI.runtime.sendMessage({ type: 'clearProxy' });
        const tmpl = (k, en) => (getTranslatedMessage(k) || en).replace('{name}', name);
        if (reasonTag === 'controlled') {
          setToast('Another extension is blocking the VPN. Disable other proxy/VPN extensions and try again.', true, 'proxy_controlled_msg');
        } else if (reasonTag === 'leak') {
          setToast(tmpl('leak_location_msg', "Couldn't confirm the connection to {name} — your IP didn't change. Please choose another location."), true);
        } else if (reasonTag === 'verify') {
          setToast(tmpl('verify_location_failed_msg', "Couldn't verify the connection to {name}. Please choose another location."), true);
        } else if (reasonTag === 'apply') {
          setToast(tmpl('unavailable_location_msg', "{name} is currently unavailable. Please choose another location."), true);
        } else {
          setToast(tmpl('connect_failed_msg', "Couldn't connect to {name} right now. Please try again or choose another location."), true);
        }
        updateProxyStatusText(null);
      };

      let authOk = await tryAuth(ip, portNumber);
      if (stale()) return;
      if (!authOk) { authOk = await tryAuth(ip, portNumber); if (stale()) return; }
      if (!authOk) return fail('auth');

      const applied = await applyProxyMsg(ip, portNumber, scheme);
      if (stale()) return;
      if (applied.status !== 'success') return fail(applied.reason === 'controlled' ? 'controlled' : 'apply');

      const verify = await verifyEgress(ip);
      if (stale()) return;
      if (!verify.ok || verify.leak) {
        await new Promise(res => browserAPI.runtime.sendMessage({ type: 'clearProxy' }, () => res()));
        return fail(verify.leak ? 'leak' : 'verify');
      }

      browserAPI.storage.local.set({ lastCountry: country });
      browserAPI.runtime.sendMessage({ type: 'setConnectedIcon', country });
      const selectedLocation = { location, ip, port: portNumber, country, countryname };
      updateRecentLocations(selectedLocation);
      updateCurrentProxy(selectedLocation);
      updateProxyStatusText(selectedLocation);
      statusRow.classList.remove('connecting');
      statusMeta.classList.remove('flash');
      void statusMeta.offsetWidth;
      statusMeta.classList.add('flash');
    }

    function clearProxy() {
      ++setProxyEpoch;
      statusRow.classList.remove('connecting');
      statusMeta.classList.remove('flash');
      browserAPI.runtime.sendMessage({ type: 'clearProxy' });
      currentProxy = null;
      browserAPI.storage.local.set({ currentProxy: null });
      updateProxyStatusText(null);
    }

    function updateProxyStatusText(selected) {
      browserAPI.storage.local.get(['lastProxy', 'currentProxy'], (data) => {
        const lastProxy = data.lastProxy;
        const cp = selected || data.currentProxy;
        const target = cp || lastProxy;
        const connected = !!cp;

        statusRow.classList.toggle('connected', connected);
        const metaKey = connected ? 'connected_label' : (target ? 'last_location_label' : 'disconnected_label');
        const metaFallback = connected ? 'Connected' : (target ? 'Last Location' : 'Disconnected');
        statusMeta.textContent = getTranslatedMessage(metaKey) || metaFallback;

        if (target) {
          const [city, state] = (target.location || '').split(',');
          let full = [target.countryname, state, city].filter(Boolean).join(', ');
          if (full.length > 34) full = [target.countryname, city].filter(Boolean).join(', ');
          proxyStatusText.textContent = full;
          proxyStatusFlag.classList.remove('no-flag');
          proxyStatusFlag.style.backgroundImage = `url('img/flags/${(target.country || '').trim().toUpperCase() || 'placeholder'}.png')`;
          proxyStatusToggle.checked = connected;
          proxyStatusToggle.setAttribute('aria-checked', connected ? 'true' : 'false');
          proxyStatusText.dataset.ip = target.ip;
          proxyStatusText.dataset.port = target.port;
          proxyStatusText.dataset.country = target.country;
          proxyStatusText.dataset.countryname = target.countryname;
          proxyStatusText.dataset.location = target.location;
        } else {
          proxyStatusText.textContent = getTranslatedMessage('hide_my_ip_label') || 'Hide My IP';
          proxyStatusFlag.classList.add('no-flag');
          proxyStatusFlag.style.backgroundImage = `url('img/icon128.png')`;
          proxyStatusToggle.checked = false;
          proxyStatusToggle.setAttribute('aria-checked', 'false');
          ['ip', 'port', 'country', 'countryname', 'location'].forEach(k => delete proxyStatusText.dataset[k]);
        }

        if (!IS_FIREFOX && browserAPI.proxy && browserAPI.proxy.settings && cp && cp.ip) {
          browserAPI.proxy.settings.get({ incognito: false }, (config) => {
            const v = config && config.value;
            const sp = v && v.rules && v.rules.singleProxy;
            const live = v && v.mode === 'fixed_servers' && sp && sp.host === cp.ip && Number(sp.port) === Number(cp.port);
            if (live) {
              proxyStatusToggle.checked = true;
              proxyStatusToggle.setAttribute('aria-checked', 'true');
              statusRow.classList.add('connected');
              statusMeta.textContent = getTranslatedMessage('connected_label') || 'Connected';
            }
          });
        }
      });
    }

    proxyStatusToggle.addEventListener('change', () => {
      proxyStatusToggle.setAttribute('aria-checked', proxyStatusToggle.checked ? 'true' : 'false');
      if (proxyStatusToggle.checked) {
        if (currentProxy) {
          setProxy(currentProxy.ip, currentProxy.port, currentProxy.country, currentProxy.countryname, currentProxy.location);
        } else {
          browserAPI.storage.local.get(['lastProxy'], (data) => {
            const lp = data.lastProxy;
            if (lp && lp.ip) {
              setProxy(lp.ip, lp.port, lp.country, lp.countryname, lp.location);
              return;
            }
            const all = proxyLocations.concat(extraLocations).filter(l => l.ip);
            if (all.length > 0) {
              const pick = all[Math.floor(Math.random() * all.length)];
              setProxy(pick.ip, pick.port, pick.country, pick.countryname, pick.location);
            }
          });
        }
      } else {
        clearProxy();
      }
    });

    function toggleRecentLocationsHeader(locations) {
      recentLocationsHeader.style.display = locations.length ? 'block' : 'none';
    }

    function setToast(messageKey, isError, transTag, sticky) {
      const msg = getTranslatedMessage(transTag) || messageKey;
      clearTimeout(toastTimer);
      toastEl.textContent = msg;
      toastEl.classList.toggle('error', !!isError);
      show(toastEl, true);
      requestAnimationFrame(() => toastEl.classList.add('visible'));
      if (!sticky) {
        toastTimer = setTimeout(() => {
          toastEl.classList.remove('visible');
          setTimeout(() => show(toastEl, false), 200);
        }, 3000);
      }
    }

    function getTranslatedMessage(k) {
      return messages[k]?.message || '';
    }

    async function checkKey(keyVal, callback) {
      try {
        const r = await apiFetch(`/?action=chkl&key=${encodeURIComponent(keyVal)}`);
        const text = await r.text();
        callback(text.includes('SUCCESS'));
      } catch {
        callback(false);
      }
    }

    function allLocations() {
      const merged = [...proxyLocations, ...extraLocations];
      const hasKey = typeof key === 'string' && key.length === 29;
      if (!hasKey) return merged;
      return merged.slice().sort((a, b) => {
        const cn = (a.countryname || '').localeCompare(b.countryname || '');
        if (cn) return cn;
        const aCity = (a.location || '').split(',')[0] || '';
        const bCity = (b.location || '').split(',')[0] || '';
        return aCity.localeCompare(bCity);
      });
    }

    function ensureFetchBanner() {
      let bannerEl = document.getElementById('fetch-error-banner');
      browserAPI.storage.local.get(['proxyLocations', 'extraLocations', 'lastFetchError'], (r) => {
        const empty = !((r.proxyLocations && r.proxyLocations.length) || (r.extraLocations && r.extraLocations.length));
        const hasErr = !!r.lastFetchError;
        if (empty && hasErr) {
          if (!bannerEl) {
            bannerEl = document.createElement('div');
            bannerEl.id = 'fetch-error-banner';
            bannerEl.style.cssText = 'margin:8px;padding:10px;background:#3a1d1d;border:1px solid #aa4444;border-radius:6px;color:#f5d0d0;font-size:12px;line-height:1.4;';
            const msg = document.createElement('div');
            msg.textContent = getTranslatedMessage('fetch_error_msg') || 'Could not load server list. Connection may be blocked. Try DNS 1.1.1.1 / 8.8.8.8 or retry.';
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = getTranslatedMessage('retry_btn') || 'Retry';
            btn.style.cssText = 'margin-top:8px;padding:6px 14px;background:#5e8;border:0;border-radius:4px;color:#000;font-weight:600;cursor:pointer;';
            btn.addEventListener('click', () => {
              btn.disabled = true; btn.textContent = '...';
              browserAPI.runtime.sendMessage({ type: 'updateLocationsFromAPI' }, () => {
                setTimeout(() => { btn.disabled = false; btn.textContent = getTranslatedMessage('retry_btn') || 'Retry'; ensureFetchBanner(); }, 800);
              });
            });
            bannerEl.append(msg, btn);
            (allContainer.parentNode || document.body).insertBefore(bannerEl, allContainer);
          }
        } else if (bannerEl) {
          bannerEl.remove();
        }
      });
    }
    ensureFetchBanner();

    displayLocations(recentLocations.slice(-3), recentContainer);
    displayLocations(allLocations(), allContainer);
    updateProxyStatusText(currentProxy);
    toggleRecentLocationsHeader(recentLocations);
    renderLicenseState();

    btnBuy?.addEventListener('click', () => browserAPI.tabs.create({ url: 'https://www.hidemyip.com/#pricing' }));
    btnUnlock?.addEventListener('click', openKeyPanel);
    btnChangeLicense?.addEventListener('click', openKeyPanel);
    btnEnterLicenseMenu?.addEventListener('click', openKeyPanel);
    btnBack?.addEventListener('click', closeKeyPanel);

    btnRemove?.addEventListener('click', () => {
      key = undefined;
      browserAPI.storage.local.remove('key', () => {
        browserAPI.storage.local.set({ lastUpdateTimestamp: 0 }, () => {
          checkAndUpdateLocations(true, null);
        });
        renderLicenseState();
        setToast('License removed.', false, 'license_removed_msg');
      });
    });

    btnEnterCodeSubmit.addEventListener('click', () => {
      const k = textareaKey.value.trim();
      if (!k) { setToast('Please enter a license key.', true, 'please_enter_key_msg'); return; }
      btnEnterCodeSubmit.classList.add('disabled');
      textareaKey.setAttribute('readonly', 'readonly');
      checkKey(k, (isValid) => {
        btnEnterCodeSubmit.classList.remove('disabled');
        textareaKey.removeAttribute('readonly');
        if (isValid) {
          key = k;
          const pendingExtra = (extraLocations || []).map(e => e.ip ? e : { ...e, ip: '__pending__' });
          extraLocations = pendingExtra;
          displayLocations(allLocations(), allContainer);
          browserAPI.storage.local.set({ key: k, lastUpdateTimestamp: 0, extraLocations: pendingExtra }, () => {
            checkAndUpdateLocations(true, k);
          });
          showBanner(getTranslatedMessage('success_key_msg') || 'Thank you for activating Hide My IP!');
          renderLicenseState();
        } else {
          setToast('Invalid License Key', true, 'invalid_key_msg');
        }
      });
    });

    preventLeakCheckbox.checked = preventipleak === '1';
    preventLeakCheckbox.addEventListener('change', () => {
      const value = preventLeakCheckbox.checked ? '1' : '';
      browserAPI.storage.local.set({ preventipleak: value });
      browserAPI.runtime.sendMessage({ type: 'updatePreventLeak', enable: preventLeakCheckbox.checked });
    });
    browserAPI.runtime.sendMessage({ type: 'updatePreventLeak', enable: preventLeakCheckbox.checked });

    const killSwitchCheckbox = document.getElementById('checkbox_killswitch');
    killSwitchCheckbox.checked = killSwitch !== false;
    killSwitchCheckbox.addEventListener('change', () => {
      browserAPI.storage.local.set({ killSwitch: killSwitchCheckbox.checked });
    });

    const killedBanner = document.getElementById('killed-banner');
    const killedBannerText = document.getElementById('killed_banner_text');
    const killedBannerClose = document.getElementById('killed_banner_close');
    function dismissKilledBanner() {
      show(killedBanner, false);
      browserAPI.storage.local.remove(['killed', 'killedAt', 'killedCountry', 'killedIp']);
    }
    killedBannerClose.addEventListener('click', dismissKilledBanner);
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'killed' in changes && !changes.killed.newValue) {
        show(killedBanner, false);
      }
    });
    if (killed && killedAt && (Date.now() - killedAt) < 60 * 60 * 1000) {
      const tmpl = getTranslatedMessage('killed_banner_msg') || '{country} server became unavailable and was disconnected. Please pick another location.';
      killedBannerText.textContent = tmpl.replace('{country}', killedCountry || 'Selected');
      show(killedBanner, true);
    } else if (killed) {
      browserAPI.storage.local.remove(['killed', 'killedAt', 'killedCountry', 'killedIp']);
    }

    const btnSettings = document.getElementById('btn_settings');
    const settingsPopover = document.getElementById('settings-popover');
    document.getElementById('btn_check_ip')?.addEventListener('click', () => {
      show(settingsPopover, false);
      btnSettings?.setAttribute('aria-expanded', 'false');
      const cp = currentProxy;
      const egressCc = (cp && cp.country) ? String(cp.country).trim().toUpperCase() : '';
      if (egressCc !== 'RU') {
        browserAPI.tabs.create({ url: 'https://www.hidemyip.com/ip' });
        return;
      }
      let ipBox = document.getElementById('ip-check-banner');
      if (ipBox) ipBox.remove();
      ipBox = document.createElement('div');
      ipBox.id = 'ip-check-banner';
      ipBox.style.cssText = 'margin:8px;padding:10px 12px;background:#1f2a3a;border:1px solid #2d4262;border-radius:6px;color:#dbe6f5;font-size:13px;line-height:1.4;display:flex;align-items:center;gap:10px;';
      const ico = document.createElement('i');
      ico.className = 'fa fa-spinner fa-spin';
      ico.style.cssText = 'opacity:0.7;';
      const txt = document.createElement('span');
      txt.textContent = (getTranslatedMessage('verifying_label') || 'Verifying...');
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '×';
      close.setAttribute('aria-label', 'Dismiss');
      close.style.cssText = 'margin-left:auto;background:transparent;border:0;color:#dbe6f5;font-size:18px;cursor:pointer;padding:0 4px;';
      close.addEventListener('click', () => ipBox.remove());
      ipBox.append(ico, txt, close);
      (allContainer.parentNode || document.body).insertBefore(ipBox, allContainer);
      browserAPI.runtime.sendMessage({ type: 'checkMyIp' }, (resp) => {
        if (resp && resp.ok && resp.ip) {
          ico.className = 'fa fa-globe';
          ico.style.color = '#5e8';
          txt.innerHTML = '';
          const lbl = document.createElement('span');
          lbl.textContent = (getTranslatedMessage('check_my_ip_label') || 'Check My IP') + ': ';
          lbl.style.opacity = '0.7';
          const ipv = document.createElement('strong');
          ipv.textContent = resp.ip;
          ipv.style.cssText = 'user-select:text;font-family:ui-monospace,Menlo,Consolas,monospace;';
          txt.append(lbl, ipv);
        } else {
          ico.className = 'fa fa-exclamation-triangle';
          ico.style.color = '#e88';
          txt.textContent = (getTranslatedMessage('verify_failed_msg') || 'Could not check IP. Try another location.');
        }
      });
    });
    btnSettings?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = settingsPopover.hasAttribute('hidden');
      show(settingsPopover, open);
      btnSettings.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('click', (e) => {
      if (!settingsPopover.hasAttribute('hidden') &&
          !settingsPopover.contains(e.target) &&
          e.target !== btnSettings && !btnSettings.contains(e.target)) {
        show(settingsPopover, false);
        btnSettings.setAttribute('aria-expanded', 'false');
      }
    });

    proxyStatusText.addEventListener('click', () => {
      const { ip, port, country, countryname, location } = proxyStatusText.dataset;
      if (ip && port) {
        proxyStatusToggle.checked = !proxyStatusToggle.checked;
        proxyStatusToggle.setAttribute('aria-checked', proxyStatusToggle.checked ? 'true' : 'false');
        if (proxyStatusToggle.checked) setProxy(ip, port, country, countryname, location);
        else clearProxy();
      }
    });

    function rerenderFromStorage() {
      browserAPI.storage.local.get(['proxyLocations', 'extraLocations', 'recentLocations', 'key'], (r) => {
        proxyLocations = r.proxyLocations || [];
        extraLocations = r.extraLocations || [];
        recentLocations = r.recentLocations || [];
        key = r.key;
        displayLocations(allLocations(), allContainer);
        displayLocations(recentLocations.slice(-3), recentContainer);
        toggleRecentLocationsHeader(recentLocations);
        renderLicenseState();
      });
    }
    window.addEventListener('locations-refreshed', () => { rerenderFromStorage(); ensureFetchBanner(); });
    browserAPI.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.proxyLocations || changes.extraLocations || changes.key) rerenderFromStorage();
      if (changes.currentProxy) {
        currentProxy = changes.currentProxy.newValue || null;
        displayLocations(allLocations(), allContainer);
        displayLocations(recentLocations.slice(-3), recentContainer);
      }
      if (changes.proxyLocations || changes.extraLocations || changes.lastFetchError) ensureFetchBanner();
    });
  });

  loadMessages();
});

function checkAndUpdateLocations(force, keyOverride) {
  browserAPI.storage.local.get('lastUpdateTimestamp', (result) => {
    const now = Date.now();
    const last = result.lastUpdateTimestamp || 0;
    if (!(force || last === 0 || now - last >= UPDATE_INTERVAL)) return;
    const msg = { type: 'updateLocationsFromAPI' };
    if (keyOverride !== undefined) msg.key = keyOverride;
    browserAPI.runtime.sendMessage(msg, (response) => {
      if (response && response.status === 'success') {
        browserAPI.storage.local.set({ lastUpdateTimestamp: now });
        window.dispatchEvent(new CustomEvent('locations-refreshed'));
      }
    });
  });
}

async function loadMessages() {
  const lang = navigator.language.split('-')[0];
  const cacheKey = `locale_${lang}`;
  const cached = await browserAPI.storage.local.get(cacheKey);
  if (cached[cacheKey]) {
    messages = cached[cacheKey];
    applyTranslations(messages);
  }
  try {
    let r = await fetch(`_locales/${lang}/messages.json`);
    if (!r.ok) r = await fetch('_locales/en/messages.json');
    const data = await r.json();
    messages = data;
    browserAPI.storage.local.set({ [cacheKey]: data });
    applyTranslations(messages);
  } catch {
    if (!cached[cacheKey]) {
      try {
        const r = await fetch('_locales/en/messages.json');
        messages = await r.json();
        applyTranslations(messages);
      } catch {}
    }
  }
}

function applyTranslations(m) {
  for (const key in m) {
    if (Object.prototype.hasOwnProperty.call(m, key)) {
      const el = document.getElementById(key);
      if (!el) continue;
      if (el.querySelector('*')) continue;
      el.textContent = m[key].message;
    }
  }
}
