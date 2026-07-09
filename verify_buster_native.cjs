const { chromium } = require("playwright");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = b.contexts()[0];
  const ID = "ikipmhhkkggibbeeafdabcehocahnicl";
  let sw = ctx.serviceWorkers().find(w => w.url().includes(ID));
  if (!sw) {
    // esperar hasta 8s a que despierte el SW de Buster
    sw = await Promise.race([
      ctx.waitForEvent("serviceworker", { predicate: w => w.url().includes(ID), timeout: 8000 }).catch(()=>null),
      new Promise(r=>setTimeout(()=>r(null), 8000))
    ]);
  }
  if (!sw) { console.log("SW_BUSTER_NO_ENCONTRADO (puede estar dormido)"); await b.close(); return; }
  const res = await sw.evaluate(() => new Promise((resolve) => {
    try {
      const port = chrome.runtime.connectNative("org.buster.client");
      let done = false;
      port.onDisconnect.addListener(() => { if(!done){done=true; resolve("DISCONNECT: " + (chrome.runtime.lastError ? chrome.runtime.lastError.message : "sin error"));} });
      port.onMessage.addListener((m) => { if(!done){done=true; resolve("MSG: " + JSON.stringify(m));} });
      setTimeout(() => { if(!done){done=true; try{port.disconnect();}catch(e){} resolve("CONECTADO_OK (puerto vivo, cliente esperando comando)");} }, 2000);
    } catch (e) { resolve("THROW: " + e.message); }
  }));
  console.log("RESULTADO connectNative:", res);
  await b.close();
})().catch(e => { console.log("ERROR script:", e.message); process.exit(1); });
