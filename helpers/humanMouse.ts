// helpers/humanMouse.ts
// Movimiento de mouse con patrones HUMANOS (solo se mueve — NO clickea, NO toca el form).
// Idea: reCAPTCHA v2 puntúa el movimiento del mouse; tener actividad humana de fondo
// baja el "risk score" y reduce challenges/bloqueos. Se corre en paralelo al flujo del RPA.
//
// Uso (sin contaminar la lógica del RPA):
//   import { startHumanMouse } from "./helpers/humanMouse";
//   const stop = startHumanMouse(page, { width: 1280, height: 800 });
//   ...tu flujo normal...
//   stop();   // al terminar / antes de cerrar la página
//
// Solo usa page.mouse.move(). Nunca click/down/up. Tolerante a errores (si la página
// se cierra, se detiene solo).
import { Page } from "playwright";

export interface HumanMouseOpts {
  width?: number;   // ancho del viewport (default 1280)
  height?: number;  // alto del viewport (default 800)
}

const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Curva Bézier cúbica (trayectoria curva, como una mano humana — no líneas rectas).
function bezier(p0: P, p1: P, p2: P, p3: P, t: number): P {
  const u = 1 - t;
  const uu = u * u, tt = t * t;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}
// Easing ease-in-out: arranca lento, acelera, frena (aceleración humana, no uniforme).
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

type P = { x: number; y: number };

/**
 * Arranca el movimiento humano de fondo. Devuelve una función para detenerlo.
 * NUNCA hace click — solo mueve el cursor.
 */
export function startHumanMouse(page: Page, opts: HumanMouseOpts = {}): () => void {
  const W = opts.width ?? 1280;
  const H = opts.height ?? 800;
  let running = true;
  let cur: P = { x: rand(0.3 * W, 0.7 * W), y: rand(0.3 * H, 0.7 * H) };

  (async () => {
    // pausa inicial (el humano no se mueve apenas carga)
    await sleep(rand(300, 900));
    while (running) {
      // destino aleatorio dentro del viewport (con margen)
      const dest: P = { x: rand(0.04 * W, 0.96 * W), y: rand(0.06 * H, 0.94 * H) };
      // 2 puntos de control desviados → curva orgánica
      const dx = dest.x - cur.x, dy = dest.y - cur.y;
      const c1: P = { x: cur.x + dx * rand(0.2, 0.5) + rand(-90, 90), y: cur.y + dy * rand(0.2, 0.5) + rand(-90, 90) };
      const c2: P = { x: cur.x + dx * rand(0.5, 0.8) + rand(-90, 90), y: cur.y + dy * rand(0.5, 0.8) + rand(-90, 90) };
      const steps = Math.floor(rand(18, 40));
      for (let i = 1; i <= steps && running; i++) {
        const t = easeInOut(i / steps);
        const p = bezier(cur, c1, c2, dest, t);
        try {
          await page.mouse.move(p.x, p.y);
        } catch {
          running = false; // página cerrada → parar
          break;
        }
        await sleep(rand(7, 22)); // velocidad variable entre micro-pasos
      }
      cur = dest;
      // pausa humana entre trayectos
      await sleep(rand(250, 1400));
      // a veces micro-jitter en el lugar (temblor natural de la mano)
      if (running && Math.random() < 0.35) {
        for (let j = 0; j < Math.floor(rand(2, 5)) && running; j++) {
          try {
            await page.mouse.move(cur.x + rand(-5, 5), cur.y + rand(-5, 5));
          } catch {
            running = false;
          }
          await sleep(rand(25, 90));
        }
      }
    }
  })().catch(() => { /* nunca romper el flujo del RPA */ });

  return () => { running = false; };
}
