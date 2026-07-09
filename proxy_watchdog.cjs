// Watchdog del proxy: cuando Google BLOQUEA la IP del proxy a mitad de operación
// (el server loguea "Audio bloqueado por Google (0 bytes)" y el pool no se llena),
// ordena a la extensión hide-my-ip ROTAR a otro server (clearProxyConfig + autoConnect).
//
// Detección: cuenta "Audio bloqueado" en el journal de rpa-server en una ventana corta;
// si supera el umbral y el pool está bajo -> rota. Con cooldown para no rotar en loop.
//
// Uso:  node proxy_watchdog.cjs        (env: CDP_PORT=9223 HEALTH_PORT=4321)
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT        = process.env.CDP_PORT    || '9223';
const HEALTH_PORT = process.env.HEALTH_PORT || '4321';
const HMI_EXT     = 'pekcnopmdcbjdgmpnpkndppflpldnkkp';
const CHECK_EVERY_MS   = parseInt(process.env.WD_CHECK_MS   || '15000', 10); // cada 15s
const WINDOW_SECS      = parseInt(process.env.WD_WINDOW     || '40', 10);    // ventana del journal
const BLOCK_THRESHOLD  = parseInt(process.env.WD_THRESHOLD  || '2', 10);     // bloqueos p/ rotar
const POOL_LOW         = parseInt(process.env.WD_POOL_LOW   || '2', 10);     // pool "bajo"
const COOLDOWN_MS      = parseInt(process.env.WD_COOLDOWN   || '45000', 10); // tras rotar

function recentBlocks() {
  try {
    const out = execSync(`journalctl -u rpa-server.service --no-pager --since "-${WINDOW_SECS}s"`,
      { encoding: 'utf8' });
    return (out.match(/Audio bloqueado/g) || []).length;
  } catch { return 0; }
}
function poolLevel() {
  try {
    const out = execSync(`curl -s --max-time 4 http://127.0.0.1:${HEALTH_PORT}/health`, { encoding: 'utf8' });
    const m = out.match(/"pool":(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}
async function getSW(ctx) {
  for (let i = 0; i < 15; i++) {
    const sw = ctx.serviceWorkers().find(w => w.url().includes(HMI_EXT));
    if (sw) return sw;
    await sleep(1000);
  }
  return null;
}
async function rotate(sw) {
  if (!sw) return null;
  return sw.evaluate(async () => {
    try { await clearProxyConfig(); } catch (e) {}
    try { await autoConnect(); } catch (e) {}
    try { const r = await chrome.storage.local.get('currentProxy'); return r.currentProxy ? r.currentProxy.ip : null; }
    catch (e) { return null; }
  }).catch(() => null);
}

(async () => {
  let b = null, ctx = null, sw = null;
  async function ensure() {
    try {
      if (b && b.isConnected()) { if (sw) return true; }
      b = await chromium.connectOverCDP({ endpointURL: 'http://127.0.0.1:' + PORT, timeout: 8000 });
      ctx = b.contexts()[0];
      sw = await getSW(ctx);
      return !!sw;
    } catch { b = null; sw = null; return false; }
  }

  console.log(`[watchdog] iniciado — rota si >=${BLOCK_THRESHOLD} bloqueos/${WINDOW_SECS}s y pool<${POOL_LOW}`);
  let lastRotate = 0;
  for (;;) {
    await sleep(CHECK_EVERY_MS);
    if (!(await ensure())) { console.log('[watchdog] sin CDP/service-worker, reintento...'); continue; }
    const blocks = recentBlocks();
    const pool = poolLevel();
    const low = (pool === null || pool < POOL_LOW);
    if (blocks >= BLOCK_THRESHOLD && low && (Date.now() - lastRotate) > COOLDOWN_MS) {
      console.log(`[watchdog] 🔴 BLOQUEO (${blocks} en ${WINDOW_SECS}s, pool=${pool}) -> rotando proxy...`);
      const newIp = await rotate(sw);
      console.log('[watchdog] ✅ rotado. nuevo proxy IP: ' + (newIp || '(desconocida)'));
      lastRotate = Date.now();
    }
  }
})().catch(e => { console.log('[watchdog] fatal: ' + e.message); process.exit(1); });
