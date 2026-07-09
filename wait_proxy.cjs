// Espera a que la extensión hide-my-ip active el proxy: la IP de salida del
// navegador debe cambiar respecto a la IP directa del host. Uso:
//   node wait_proxy.cjs <CDP_PORT> <DIRECT_IP> [timeoutSeg]
const path = require('path');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.argv[2] || '9223';
const DIRECT_IP = (process.argv[3] || '').trim();
const TIMEOUT = parseInt(process.argv[4] || '45', 10);
(async () => {
  let b;
  for (let t = 0; t < 10 && !b; t++) {
    try { b = await chromium.connectOverCDP({ endpointURL: 'http://127.0.0.1:' + PORT, timeout: 8000 }); }
    catch { await sleep(1500); }
  }
  if (!b) { console.log('[wait_proxy] no CDP'); process.exit(2); }
  const ctx = b.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  const start = Date.now();
  let lastIp = '';
  while ((Date.now() - start) / 1000 < TIMEOUT) {
    const ip = await page.evaluate(async () => {
      try { const r = await fetch('https://api.ipify.org?format=json', { cache: 'no-store' }); return (await r.json()).ip; }
      catch (e) { return 'ERR'; }
    }).catch(() => 'ERR');
    lastIp = ip;
    if (ip && ip !== 'ERR' && ip !== DIRECT_IP) {
      console.log('[wait_proxy] proxy ACTIVO, egress=' + ip + ' (directo=' + DIRECT_IP + ')');
      await b.close(); process.exit(0);
    }
    await sleep(2500);
  }
  console.log('[wait_proxy] TIMEOUT, egress=' + lastIp + ' (directo=' + DIRECT_IP + ') — sigue en IP directa');
  await b.close(); process.exit(1);
})().catch(e => { console.log('[wait_proxy] err', e.message); process.exit(2); });
