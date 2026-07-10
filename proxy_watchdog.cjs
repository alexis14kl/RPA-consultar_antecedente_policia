// Watchdog / supervisor del proxy hide-my-ip. Dos motivos para ROTAR la IP:
//   1) PROXY MUERTO: el proxy no conecta (el server loguea ERR_PROXY/TUNNEL/SOCKS
//      _CONNECTION_FAILED — la página ni carga). Rota apenas aparece (1 basta).
//   2) IP FLAGEADA: Google bloquea el audio a mitad de operación ("Audio bloqueado
//      por Google (0 bytes)") y el pool no llena. Rota si supera el umbral y pool bajo.
//
// GRACE PERIOD (clave): el proxy nuevo tarda ~3-5s en levantarse. Tras rotar, el
// supervisor ESPERA WD_GRACE_MS antes de volver a evaluar → no declara "malo" a un
// proxy que todavía está subiendo (evita el churn de rotar sin que ninguno estabilice).
//
// Uso:  node proxy_watchdog.cjs        (env: CDP_PORT=9223 HEALTH_PORT=4321)
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT        = process.env.CDP_PORT    || '9223';
const HEALTH_PORT = process.env.HEALTH_PORT || '4321';
const HMI_EXT     = 'pekcnopmdcbjdgmpnpkndppflpldnkkp';
const CHECK_EVERY_MS      = parseInt(process.env.WD_CHECK_MS      || '15000', 10); // cada 15s
const WINDOW_SECS         = parseInt(process.env.WD_WINDOW        || '40', 10);    // ventana del journal
const BLOCK_THRESHOLD     = parseInt(process.env.WD_THRESHOLD     || '2', 10);     // "Audio bloqueado" p/ rotar
const PROXY_ERR_THRESHOLD = parseInt(process.env.WD_PROXY_ERR     || '1', 10);     // errores de conexión p/ rotar (muerto)
const POOL_LOW            = parseInt(process.env.WD_POOL_LOW      || '2', 10);     // pool "bajo"
const COOLDOWN_MS         = parseInt(process.env.WD_COOLDOWN      || '45000', 10); // mínimo entre rotaciones
const GRACE_MS            = parseInt(process.env.WD_GRACE_MS      || '6000', 10);  // esperar que el proxy nuevo levante

// Errores de conexión = proxy MUERTO (no enruta / no responde).
const PROXY_ERR_RE = /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_PROXY_CERTIFICATE_INVALID/g;

function recentJournal() {
  try {
    return execSync(`journalctl -u rpa-server.service --no-pager --since "-${WINDOW_SECS}s"`,
      { encoding: 'utf8' });
  } catch { return ''; }
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

  console.log(`[watchdog] iniciado — rota si proxy MUERTO (>=${PROXY_ERR_THRESHOLD} err conexión) o FLAGEADO (>=${BLOCK_THRESHOLD} bloqueos/${WINDOW_SECS}s, pool<${POOL_LOW}); grace ${GRACE_MS}ms`);
  let lastRotate = 0;
  for (;;) {
    await sleep(CHECK_EVERY_MS);
    if (!(await ensure())) { console.log('[watchdog] sin CDP/service-worker, reintento...'); continue; }

    const journal = recentJournal();
    const proxyErrs = (journal.match(PROXY_ERR_RE) || []).length;
    const blocks = (journal.match(/Audio bloqueado/g) || []).length;
    const pool = poolLevel();
    const low = (pool === null || pool < POOL_LOW);
    const cooldownOk = (Date.now() - lastRotate) > COOLDOWN_MS;

    let reason = null;
    if (proxyErrs >= PROXY_ERR_THRESHOLD && cooldownOk) {
      reason = `PROXY MUERTO (${proxyErrs} err conexión en ${WINDOW_SECS}s)`;
    } else if (blocks >= BLOCK_THRESHOLD && low && cooldownOk) {
      reason = `IP FLAGEADA (${blocks} bloqueos en ${WINDOW_SECS}s, pool=${pool})`;
    }

    if (reason) {
      console.log(`[watchdog] 🔴 ${reason} -> rotando proxy...`);
      const newIp = await rotate(sw);
      lastRotate = Date.now();
      console.log('[watchdog] ✅ rotado. nuevo proxy IP: ' + (newIp || '(desconocida)'));
      // Grace: el proxy nuevo tarda ~3-5s en levantarse. Esperar antes de re-evaluar
      // para no declararlo "malo" mientras sube (evita el churn de rotaciones).
      console.log(`[watchdog] ⏳ grace ${GRACE_MS}ms — dejando que el proxy nuevo levante...`);
      await sleep(GRACE_MS);
    }
  }
})().catch(e => { console.log('[watchdog] fatal: ' + e.message); process.exit(1); });
