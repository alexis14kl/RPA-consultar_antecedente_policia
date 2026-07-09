const { chromium } = require("playwright");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = b.contexts()[0];
  const ID = "ikipmhhkkggibbeeafdabcehocahnicl";
  let sw = ctx.serviceWorkers().find(w => w.url().includes(ID));
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { predicate: w => w.url().includes(ID), timeout: 8000 }).catch(()=>null);
  if (!sw) { console.log("SW_BUSTER_NO_ENCONTRADO"); await b.close(); return; }
  await sw.evaluate(() => chrome.storage.local.set({ simulateUserInput: true, navigateWithKeyboard: true }));
  const after = await sw.evaluate(() => chrome.storage.local.get(["simulateUserInput","navigateWithKeyboard","autoUpdateClientApp","speechService","enableManagedLocalServices"]));
  console.log("== settings DESPUES ==");
  for (const k of Object.keys(after)) console.log(`  ${k} = ${JSON.stringify(after[k])}`);
  // reconfirmar que el cliente nativo sigue conectando con el toggle ON
  const conn = await sw.evaluate(() => new Promise((resolve) => {
    try {
      const p = chrome.runtime.connectNative("org.buster.client");
      let done=false;
      p.onDisconnect.addListener(()=>{ if(!done){done=true; resolve("DISCONNECT: "+(chrome.runtime.lastError?chrome.runtime.lastError.message:"sin error"));} });
      setTimeout(()=>{ if(!done){done=true; try{p.disconnect();}catch(e){} resolve("CONECTADO_OK");} }, 1500);
    } catch(e){ resolve("THROW: "+e.message); }
  }));
  console.log("== connectNative:", conn);
  await b.close();
})().catch(e => { console.log("ERROR:", e.message); process.exit(1); });
