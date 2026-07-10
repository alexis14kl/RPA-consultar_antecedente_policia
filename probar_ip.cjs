// Canario de IP: prueba la IP del proxy hide-my-ip ACTUAL contra el demo de
// reCAPTCHA (https://www.google.com/recaptcha/api2/demo) — NO quema el target
// real de la policía. El risk-score de reCAPTCHA es sobre todo por IP, así que el
// hard-block del audio en el demo predice el del sitio real.
//
// Uso:
//   node probar_ip.cjs           -> testea 1 vez; imprime veredicto; exit 0=OK 1=BANEADA
//   node probar_ip.cjs --rotar   -> testea; si BANEADA rota hide-my-ip y reintenta
//                                    hasta OK o PROBE_MAX_ROTATE; exit 0 si encontró una buena
//
// Veredicto:
//   ok-verde = checkbox pasó verde sin challenge (IP muy buena)
//   ok-audio = hubo challenge pero Google SIRVE el audio (resoluble por Buster/Whisper)
//   baneada  = hard-block (audio deshabilitado / "automated queries" / no sirve audio)
//
// CAVEATS (medidos empíricamente):
//   - reCAPTCHA es probabilístico: la MISMA IP dio 0/5 y 2/3 en ventanas seguidas.
//     Por eso multi-muestra + umbral BAJO (rotar solo si 0/N = muerta consistente).
//   - El demo es reCAPTCHA v2; la policía es v2 ENTERPRISE (más estricto). El demo es
//     más permisivo → una IP "usable" en el demo puede igual fallar en el Enterprise.
//     Sirve para DESCARTAR las muertas de verdad, no para GARANTIZAR que una rinda.
//   - Se usa como pre-flight (ExecStartPre del server, con --rotar) y como diagnóstico
//     manual. La rotación fina de producción la maneja el circuit-breaker + watchdog.
const path = require('path');
const { chromium } = require(path.join(__dirname, 'node_modules', 'playwright'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PORT = process.env.CDP_PORT || '9223';
const HMI_EXT = 'pekcnopmdcbjdgmpnpkndppflpldnkkp';
const DEMO = 'https://www.google.com/recaptcha/api2/demo';
const MAX_ROTATE = parseInt(process.env.PROBE_MAX_ROTATE || '5', 10);
const GRACE_MS = parseInt(process.env.PROBE_GRACE || '6000', 10);
// Multi-muestra: reCAPTCHA es probabilístico → 1 sola corrida es ruidosa (misma IP
// da ok/baneada distinto). Evaluamos SAMPLES corridas y la IP es USABLE si pasa
// >= MIN_PASS (distingue "muerta 0%" de "sirve a veces"). Solo rotamos las muertas.
const SAMPLES = parseInt(process.env.PROBE_SAMPLES || '5', 10);
const MIN_PASS = parseInt(process.env.PROBE_MIN_PASS || '1', 10);
const rotarFlag = process.argv.includes('--rotar');

async function currentIp(ctx) {
  const sw = ctx.serviceWorkers().find(w => w.url().includes(HMI_EXT));
  if (!sw) return null;
  return sw.evaluate(async () => {
    try { const r = await chrome.storage.local.get('currentProxy'); return r.currentProxy ? r.currentProxy.ip : null; }
    catch (e) { return null; }
  }).catch(() => null);
}
async function rotate(ctx) {
  const sw = ctx.serviceWorkers().find(w => w.url().includes(HMI_EXT));
  if (!sw) return null;
  return sw.evaluate(async () => {
    try { await clearProxyConfig(); } catch (e) {}
    try { await autoConnect(); } catch (e) {}
    try { const r = await chrome.storage.local.get('currentProxy'); return r.currentProxy ? r.currentProxy.ip : null; }
    catch (e) { return null; }
  }).catch(() => null);
}

async function probarIP(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(DEMO, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const anchor = page.frameLocator('iframe[title="reCAPTCHA"]');
    await anchor.locator('#recaptcha-anchor').waitFor({ state: 'visible', timeout: 15000 });
    await anchor.locator('#recaptcha-anchor > div:first-child').click();

    // ¿pasó verde sin challenge? (mejor caso)
    for (let i = 0; i < 8; i++) {
      const checked = await anchor.locator('#recaptcha-anchor').getAttribute('aria-checked').catch(() => 'false');
      if (checked === 'true') return 'ok-verde';
      await sleep(500);
    }

    // Hubo challenge → ir al audio
    const bframe = page.frameLocator('iframe[src*="bframe"]');
    const audioBtn = bframe.locator('#recaptcha-audio-button');
    await audioBtn.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    if (await audioBtn.isVisible().catch(() => false)) {
      const disabled = await audioBtn.evaluate(el => el.disabled || el.classList.contains('rc-button-disabled')).catch(() => false);
      if (disabled) return 'baneada';
      await audioBtn.click().catch(() => {});
      await sleep(2500);
    }

    // ¿mensaje de bloqueo "automated queries"?
    if (await bframe.locator('.rc-doscaptcha-header, .rc-doscaptcha-body').isVisible().catch(() => false)) return 'baneada';

    // ¿Google sirve el audio? (link de descarga con payload)
    const dl = bframe.locator('.rc-audiochallenge-tdownload-link, a[href*="payload"]');
    if (await dl.isVisible().catch(() => false)) {
      const href = await dl.getAttribute('href').catch(() => null);
      if (href) return 'ok-audio';
    }
    return 'baneada';
  } catch (e) {
    return 'error:' + ((e && e.message) || '').split('\n')[0];
  } finally {
    await page.close().catch(() => {});
  }
}

// Evalúa la IP actual en hasta SAMPLES muestras. Usable si pasa >= MIN_PASS.
// Early-exit: apenas llega a MIN_PASS corta (una IP que sirve resuelve rápido;
// solo una IP muerta corre las SAMPLES completas antes de declararla muerta).
async function evaluarIP(ctx) {
  let pass = 0;
  const detalle = [];
  for (let i = 0; i < SAMPLES; i++) {
    const v = await probarIP(ctx);
    const ok = v.startsWith('ok');
    detalle.push(ok ? '✓' : (v === 'baneada' ? '✗' : '?'));
    if (ok) { pass++; if (pass >= MIN_PASS) break; }
    await sleep(1500);
  }
  return { pass, usable: pass >= MIN_PASS, detalle: detalle.join('') };
}

(async () => {
  const b = await chromium.connectOverCDP({ endpointURL: 'http://127.0.0.1:' + PORT, timeout: 8000 });
  const ctx = b.contexts()[0];
  let intentos = 0;
  for (;;) {
    const ip = await currentIp(ctx);
    const { pass, usable, detalle } = await evaluarIP(ctx);
    if (usable) {
      console.log(`[probe] ✅ IP USABLE — ${pass}/${SAMPLES} [${detalle}]  ip=${ip || '?'}`);
      await b.close(); process.exit(0);
    }
    console.log(`[probe] 🚫 IP MUERTA — ${pass}/${SAMPLES} [${detalle}] (< ${MIN_PASS})  ip=${ip || '?'}`);
    if (!rotarFlag || intentos >= MAX_ROTATE) { await b.close(); process.exit(1); }
    intentos++;
    const nueva = await rotate(ctx);
    console.log(`[probe] 🔁 rotado (${intentos}/${MAX_ROTATE}) → ${nueva || '?'}, grace ${GRACE_MS}ms`);
    await sleep(GRACE_MS);
  }
})().catch(e => { console.log('[probe] fatal: ' + e.message); process.exit(2); });
