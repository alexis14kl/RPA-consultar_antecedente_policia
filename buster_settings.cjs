const { chromium } = require("playwright");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9223");
  const ctx = b.contexts()[0];
  const ID = "ikipmhhkkggibbeeafdabcehocahnicl";
  let sw = ctx.serviceWorkers().find(w => w.url().includes(ID));
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { predicate: w => w.url().includes(ID), timeout: 8000 }).catch(()=>null);
  if (!sw) { console.log("SW_BUSTER_NO_ENCONTRADO"); await b.close(); return; }
  const all = await sw.evaluate(() => chrome.storage.local.get(null));
  const keys = Object.keys(all).sort();
  const rel = keys.filter(k => /client|simulat|keyboard|input|native|speech|loc|remote|manag/i.test(k));
  console.log("== settings relacionados a client-app / speech ==");
  for (const k of rel) console.log(`  ${k} = ${JSON.stringify(all[k])}`);
  console.log("== todas las keys ==");
  console.log("  " + keys.join(", "));
  await b.close();
})().catch(e => { console.log("ERROR:", e.message); process.exit(1); });
