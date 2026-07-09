// Gate de estabilidad del proxy: NO libera el CDP hasta confirmar conexión real
// a internet A TRAVÉS del proxy (ping). Si el ping falla, el proxy no cargó bien
// -> ordena a la extensión hide-my-ip reconectar/rotar a otro server y reintenta,
// hasta que el ping pase (o se agote el tiempo). Da estabilidad al RPA.
//
// Uso: node wait_proxy.cjs <CDP_PORT> <DIRECT_IP> [maxSeconds]
//   exit 0 = proxy sano (ping OK y egress != IP directa) -> se puede usar el CDP
//   exit 1 = no se logró proxy sano dentro del tiempo
//   exit 2 = no hubo CDP
const path = require('path');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = process.argv[2] || '9223';
const DIRECT_IP = (process.argv[3] || '').trim();
const MAX_SECS = parseInt(process.argv[4] || '90', 10);
const HMI_EXT = 'pekcnopmdcbjdgmpnpkndppflpldnkkp';

// Ping: pide la IP pública desde el navegador (pasa por el proxy). Devuelve la IP
// o '' si no hay conexión. Varios proveedores por robustez.
async function ping(page) {
  return page.evaluate(async () => {
    const urls = [
      'https://api.ipify.org?format=json',
      'https://ipv4.icanhazip.com/',
      'https://checkip.amazonaws.com/',
    ];
    for (const u of urls) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(u + (u.includes('?') ? '&' : '?') + '_=' + Math.random(), { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(t);
        if (!r.ok) continue;
        const txt = (await r.text()).trim();
        const m = txt.match(/\d{1,3}(?:\.\d{1,3}){3}/);
        if (m) return m[0];
      } catch (e) { /* siguiente */ }
    }
    return '';
  }).catch(() => '');
}

async function getSW(ctx) {
  for (let i = 0; i < 15; i++) {
    const sw = ctx.serviceWorkers().find(w => w.url().includes(HMI_EXT));
    if (sw) return sw;
    await sleep(1000);
  }
  return null;
}

async function reconnect(sw) {
  if (!sw) return null;
  return sw.evaluate(async () => {
    try { await clearProxyConfig(); } catch (e) {}
    try { await autoConnect(); } catch (e) {}
    try { const r = await chrome.storage.local.get('currentProxy'); return r.currentProxy ? r.currentProxy.ip : null; }
    catch (e) { return null; }
  }).catch(() => null);
}

(async () => {
  let b;
  for (let t = 0; t < 12 && !b; t++) {
    try { b = await chromium.connectOverCDP({ endpointURL: 'http://127.0.0.1:' + PORT, timeout: 8000 }); }
    catch { await sleep(1500); }
  }
  if (!b) { console.log('[gate] no CDP en ' + PORT); process.exit(2); }

  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  const sw = await getSW(ctx);
  if (!sw) console.log('[gate] aviso: sin service worker hide-my-ip (no podré rotar, solo esperar)');

  const start = Date.now();
  let attempt = 0;
  while ((Date.now() - start) / 1000 < MAX_SECS) {
    const ip = await ping(page);
    const healthy = ip && ip !== 'ERR' && ip !== DIRECT_IP;
    if (healthy) {
      console.log('[gate] ✅ proxy SANO — ping OK, egress=' + ip + ' (directo=' + DIRECT_IP + ')');
      await b.close();
      process.exit(0);
    }
    attempt++;
    const motivo = !ip ? 'sin internet (proxy no cargó)' : (ip === DIRECT_IP ? 'aún en IP directa' : 'ping raro=' + ip);
    console.log('[gate] intento ' + attempt + ': ' + motivo + ' -> reconectando/rotando...');
    const newIp = await reconnect(sw);
    if (newIp) console.log('[gate]   nuevo server: ' + newIp);
    await sleep(3000);
  }
  console.log('[gate] ⚠️ TIMEOUT: no se logró proxy sano en ' + MAX_SECS + 's');
  await b.close();
  process.exit(1);
})().catch(e => { console.log('[gate] err ' + e.message); process.exit(2); });
