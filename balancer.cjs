// Balanceador de cargas / router del RPA de antecedentes.
//
// Idea (arquitectura de balanceo): correr N instancias COMPLETAS del stack, cada una
// con SU propio Chrome + SU propia extensión hide-my-ip → SU propia IP. Este router va
// adelante, chequea la salud de cada backend, y rutea a la más sana. Si una se cae o su
// IP se flagea (pool en 0), rutea a otra → failover INVISIBLE para el usuario.
//
// Por qué funciona (lo importante): el ban de reCAPTCHA es a la IP, no al proceso. Como
// cada instancia tiene su propia IP (vía su hide-my-ip), un flag en una NO tumba a la
// otra. Además da paralelismo → sube el techo de solves/ventana.
//
// cloudflared apunta ACÁ (BALANCER_PORT), no a un server directo.
//   env: BALANCER_PORT=4300  BACKENDS=http://127.0.0.1:4321,http://127.0.0.1:4322
const http = require('http');

const FRONT_PORT      = parseInt(process.env.BALANCER_PORT || '4300', 10);
const BACKENDS        = (process.env.BACKENDS || 'http://127.0.0.1:4321,http://127.0.0.1:4322')
                          .split(',').map(s => s.trim()).filter(Boolean);
const HEALTH_EVERY_MS = parseInt(process.env.HEALTH_EVERY || '5000', 10);
const REQ_TIMEOUT_MS  = parseInt(process.env.REQ_TIMEOUT  || '130000', 10);

// Estado de salud por backend: { up, pool, listening, ts }
const health = new Map();
BACKENDS.forEach(b => health.set(b, { up: false, pool: 0, ts: 0 }));

function checkHealth(url) {
  return new Promise(resolve => {
    const req = http.get(url + '/health', { timeout: 4000 }, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          health.set(url, { up: !!j.ok, pool: j.pool || 0, ts: Date.now() });
        } catch { health.set(url, { up: false, pool: 0, ts: Date.now() }); }
        resolve();
      });
    });
    const fail = () => { req.destroy(); health.set(url, { up: false, pool: 0, ts: Date.now() }); resolve(); };
    req.on('error', fail);
    req.on('timeout', fail);
  });
}

async function healthLoop() {
  for (;;) {
    await Promise.all(BACKENDS.map(checkHealth));
    await new Promise(r => setTimeout(r, HEALTH_EVERY_MS));
  }
}

// Elige el backend sano con MÁS tokens listos (least-loaded / most-ready).
// Si ninguno tiene pool>0 pero alguno responde /health, igual lo usa (resolverá on-demand).
function pickBackend() {
  const up = BACKENDS.filter(b => health.get(b).up);
  if (up.length === 0) return null;
  up.sort((a, b) => health.get(b).pool - health.get(a).pool);
  return up[0];
}

function proxyTo(req, res, backend, bodyChunks) {
  const t = new URL(backend);
  const preq = http.request({
    hostname: t.hostname, port: t.port, path: req.url, method: req.method,
    headers: req.headers, timeout: REQ_TIMEOUT_MS,
  }, pres => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"backend error"}'); } });
  preq.on('timeout', () => { preq.destroy(); if (!res.headersSent) { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"timeout"}'); } });
  if (bodyChunks) preq.end(Buffer.concat(bodyChunks)); else req.pipe(preq);
}

const server = http.createServer((req, res) => {
  // Estado del balanceador
  if (req.url === '/balancer/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ backends: BACKENDS.map(b => ({ url: b, ...health.get(b) })) }, null, 2));
    return;
  }
  const backend = pickBackend();
  if (!backend) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"sin backend sano"}');
    return;
  }
  // GET (health, screenshot): stream directo. POST (consultar/lote): bufferear el body
  // para poder REINTENTAR en otro backend si el elegido falla al conectar.
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => proxyTo(req, res, backend, chunks));
  } else {
    proxyTo(req, res, backend, null);
  }
});

healthLoop();
server.listen(FRONT_PORT, '127.0.0.1', () => {
  console.log(`[balancer] :${FRONT_PORT} -> ${BACKENDS.join(', ')} (health cada ${HEALTH_EVERY_MS}ms)`);
});
