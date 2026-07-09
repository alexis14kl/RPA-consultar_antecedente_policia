// Control manual del proxy hide-my-ip por CDP.
//   node proxy_ctl.cjs status   -> imprime la IP actual del proxy (currentProxy.ip)
//   node proxy_ctl.cjs rotate   -> fuerza rotación a otro server e imprime la IP nueva
const path = require('path');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.CDP_PORT || '9223';
const HMI_EXT = 'pekcnopmdcbjdgmpnpkndppflpldnkkp';
const CMD = process.argv[2] || 'status';

async function getSW(ctx) {
  for (let i = 0; i < 15; i++) {
    const sw = ctx.serviceWorkers().find(w => w.url().includes(HMI_EXT));
    if (sw) return sw;
    await sleep(800);
  }
  return null;
}
async function currentIp(sw) {
  return sw.evaluate(async () => {
    try { const r = await chrome.storage.local.get('currentProxy'); return r.currentProxy ? r.currentProxy.ip : null; }
    catch (e) { return null; }
  }).catch(() => null);
}
async function rotate(sw) {
  return sw.evaluate(async () => {
    try { await clearProxyConfig(); } catch (e) {}
    try { await autoConnect(); } catch (e) {}
    try { const r = await chrome.storage.local.get('currentProxy'); return r.currentProxy ? r.currentProxy.ip : null; }
    catch (e) { return null; }
  }).catch(() => null);
}

(async () => {
  let b;
  for (let t = 0; t < 8 && !b; t++) {
    try { b = await chromium.connectOverCDP({ endpointURL: 'http://127.0.0.1:' + PORT, timeout: 8000 }); }
    catch { await sleep(1000); }
  }
  if (!b) { console.log('sin-CDP'); process.exit(2); }
  const ctx = b.contexts()[0];
  const sw = await getSW(ctx);
  if (!sw) { console.log('sin-service-worker'); await b.close(); process.exit(3); }
  if (CMD === 'rotate') {
    const ip = await rotate(sw);
    console.log(ip || 'rotado-sin-ip');
  } else {
    const ip = await currentIp(sw);
    console.log(ip || 'desconocida');
  }
  await b.close();
  process.exit(0);
})().catch(e => { console.log('err:' + e.message); process.exit(1); });
