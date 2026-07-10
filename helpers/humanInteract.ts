// helpers/humanInteract.ts
// Interacción HUMANA unificada para bajar el risk score de reCAPTCHA. A diferencia
// de humanMouse.ts (que solo movía el cursor de fondo y dejaba los clicks sintéticos
// de Playwright — que "teletransportan" sin aproximación natural), acá el MISMO mouse
// hace: (a) movimiento idle de fondo, y (b) clicks/tipeo DELIBERADOS que se aproximan
// al elemento con curva + desaceleración + hover + presión real. Comparten estado
// (posición + flag busy) → no se pelean por el cursor.
//
// Patrones: Strategy (perfiles de comportamiento intercambiables por worker) +
// acciones tipo Command (move/click/type encapsuladas). Sin Observer/Iterator (forzados).
import { Page, Locator } from "playwright";

type P = { x: number; y: number };
const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bezier(p0: P, p1: P, p2: P, p3: P, t: number): P {
  const u = 1 - t, uu = u * u, tt = t * t;
  return {
    x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
    y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
  };
}
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

// ── Strategy: perfiles de "personalidad" (una por worker → menos uniforme = menos bot)
export interface Profile {
  name: string;
  moveStepMs: [number, number]; // pausa entre micro-pasos del movimiento
  steps: [number, number];      // cantidad de micro-pasos por trayecto
  hoverMs: [number, number];    // hover sobre el elemento antes de presionar
  pressMs: [number, number];    // duración del mouse-down → up (la "pulsada")
  typeMs: [number, number];     // pausa entre teclas
  typoProb: number;             // prob. de typo + backspace por tecla
  idlePauseMs: [number, number];// pausa del idle entre trayectos
}
export const PROFILES: Profile[] = [
  { name: "rápido",    moveStepMs: [5, 14],  steps: [16, 28], hoverMs: [80, 220],  pressMs: [45, 95],  typeMs: [55, 150],  typoProb: 0.03, idlePauseMs: [200, 900] },
  { name: "normal",    moveStepMs: [8, 20],  steps: [20, 36], hoverMs: [150, 420], pressMs: [60, 125], typeMs: [90, 230],  typoProb: 0.05, idlePauseMs: [300, 1300] },
  { name: "cuidadoso", moveStepMs: [12, 28], steps: [26, 44], hoverMs: [260, 680], pressMs: [80, 160], typeMs: [130, 320], typoProb: 0.07, idlePauseMs: [500, 1800] },
];
export const pickProfile = (): Profile => PROFILES[randInt(0, PROFILES.length - 1)];

export interface HumanMouse {
  startIdle(): void;
  moveTo(x: number, y: number): Promise<void>;
  click(target: Locator | P): Promise<void>;
  type(field: Locator, text: string): Promise<void>;
  stop(): void;
  profile: Profile;
}

export function createHumanMouse(page: Page, opts: { width?: number; height?: number; profile?: Profile } = {}): HumanMouse {
  const W = opts.width ?? 1280, H = opts.height ?? 800;
  const prof = opts.profile ?? pickProfile();
  let running = true;
  let busy = false; // acción deliberada en curso → el idle cede el cursor
  let cur: P = { x: rand(0.3 * W, 0.7 * W), y: rand(0.3 * H, 0.7 * H) };

  // Trayecto curvo (bezier) desde cur hasta dest. checkBusy: si true, corta si aparece
  // una acción deliberada (para que el idle no pise un click).
  async function travel(dest: P, checkBusy: boolean): Promise<void> {
    const dx = dest.x - cur.x, dy = dest.y - cur.y;
    const c1: P = { x: cur.x + dx * rand(0.2, 0.5) + rand(-85, 85), y: cur.y + dy * rand(0.2, 0.5) + rand(-85, 85) };
    const c2: P = { x: cur.x + dx * rand(0.5, 0.8) + rand(-85, 85), y: cur.y + dy * rand(0.5, 0.8) + rand(-85, 85) };
    const steps = randInt(prof.steps[0], prof.steps[1]);
    for (let i = 1; i <= steps && running; i++) {
      if (checkBusy && busy) return;
      const p = bezier(cur, c1, c2, dest, easeInOut(i / steps));
      try { await page.mouse.move(p.x, p.y); } catch { running = false; return; }
      cur = p;
      await sleep(rand(prof.moveStepMs[0], prof.moveStepMs[1]));
    }
    cur = dest;
  }

  async function moveTo(x: number, y: number): Promise<void> { await travel({ x, y }, false); }

  async function pointOf(target: Locator | P): Promise<P | null> {
    if ("x" in target) return target;
    const box = await target.boundingBox().catch(() => null);
    if (!box) return null;
    // Punto aleatorio DENTRO del elemento (no siempre el centro, evitando bordes).
    return { x: box.x + box.width * rand(0.3, 0.7), y: box.y + box.height * rand(0.3, 0.7) };
  }

  async function click(target: Locator | P): Promise<void> {
    busy = true;
    try {
      const pt = await pointOf(target);
      if (!pt) { if (!("x" in target)) await (target as Locator).click({ timeout: 8000 }).catch(() => {}); return; }
      await travel(pt, false);                                   // aproximación con curva + desaceleración
      await sleep(rand(prof.hoverMs[0], prof.hoverMs[1]));       // hover (el humano no clickea al instante)
      try { await page.mouse.move(pt.x + rand(-2, 2), pt.y + rand(-2, 2)); } catch {} // micro-ajuste
      try { await page.mouse.down(); } catch {}
      await sleep(rand(prof.pressMs[0], prof.pressMs[1]));       // pulsada real
      try { await page.mouse.up(); } catch {}
    } finally { busy = false; }
  }

  async function type(field: Locator, text: string): Promise<void> {
    busy = true;
    try {
      await click(field);                    // click humano para enfocar el campo
      await sleep(rand(140, 380));
      for (const ch of text) {
        if (Math.random() < prof.typoProb) { // typo ocasional + corrección
          const wrong = String.fromCharCode(ch.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
          try { await page.keyboard.type(wrong); } catch {}
          await sleep(rand(prof.typeMs[0], prof.typeMs[1]));
          try { await page.keyboard.press("Backspace"); } catch {}
          await sleep(rand(90, 210));
        }
        try { await page.keyboard.type(ch); } catch {}
        await sleep(rand(prof.typeMs[0], prof.typeMs[1]));
      }
    } finally { busy = false; }
  }

  function startIdle(): void {
    (async () => {
      await sleep(rand(300, 900)); // el humano no se mueve apenas carga
      while (running) {
        if (busy) { await sleep(120); continue; } // cede el cursor a las acciones deliberadas
        await travel({ x: rand(0.05 * W, 0.95 * W), y: rand(0.08 * H, 0.92 * H) }, true);
        await sleep(rand(prof.idlePauseMs[0], prof.idlePauseMs[1]));
        if (running && !busy && Math.random() < 0.35) { // micro-temblor natural en el lugar
          for (let j = 0; j < randInt(2, 4) && running && !busy; j++) {
            try { await page.mouse.move(cur.x + rand(-5, 5), cur.y + rand(-5, 5)); } catch { running = false; }
            await sleep(rand(25, 90));
          }
        }
      }
    })().catch(() => { /* nunca romper el flujo del RPA */ });
  }

  return { startIdle, moveTo, click, type, stop: () => { running = false; }, profile: prof };
}
