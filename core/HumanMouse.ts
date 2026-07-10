// core/HumanMouse.ts
// Interacción HUMANA con la página para bajar el risk score de reCAPTCHA.
// Un mismo cursor hace movimiento idle de fondo + clicks/tipeo DELIBERADOS que se
// aproximan al elemento (bezier + desaceleración), hover y presión real — a diferencia
// del click sintético de Playwright, que "teletransporta" y grita bot.
//
// Patrón Strategy: `Profile` define la "personalidad" (velocidad, dudas, jitter);
// cada worker toma una → el comportamiento no es uniforme.
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

/** Strategy: perfil de comportamiento (una "personalidad" por worker). */
export interface Profile {
  name: string;
  moveStepMs: [number, number];
  steps: [number, number];
  hoverMs: [number, number];
  pressMs: [number, number];
  typeMs: [number, number];
  typoProb: number;
  idlePauseMs: [number, number];
}

export const PROFILES: Profile[] = [
  { name: "rápido",    moveStepMs: [5, 14],  steps: [16, 28], hoverMs: [80, 220],  pressMs: [45, 95],  typeMs: [55, 150],  typoProb: 0.03, idlePauseMs: [200, 900] },
  { name: "normal",    moveStepMs: [8, 20],  steps: [20, 36], hoverMs: [150, 420], pressMs: [60, 125], typeMs: [90, 230],  typoProb: 0.05, idlePauseMs: [300, 1300] },
  { name: "cuidadoso", moveStepMs: [12, 28], steps: [26, 44], hoverMs: [260, 680], pressMs: [80, 160], typeMs: [130, 320], typoProb: 0.07, idlePauseMs: [500, 1800] },
];

export interface HumanMouseOpts { width?: number; height?: number; profile?: Profile; }

export class HumanMouse {
  readonly profile: Profile;
  private readonly W: number;
  private readonly H: number;
  private running = true;
  private busy = false;        // acción deliberada en curso → el idle cede el cursor
  private cur: P;

  constructor(private readonly page: Page, opts: HumanMouseOpts = {}) {
    this.W = opts.width ?? 1280;
    this.H = opts.height ?? 800;
    this.profile = opts.profile ?? PROFILES[randInt(0, PROFILES.length - 1)];
    this.cur = { x: rand(0.3 * this.W, 0.7 * this.W), y: rand(0.3 * this.H, 0.7 * this.H) };
  }

  /** Trayecto curvo desde la posición actual hasta dest. */
  private async travel(dest: P, cancelIfBusy: boolean): Promise<void> {
    const dx = dest.x - this.cur.x, dy = dest.y - this.cur.y;
    const c1: P = { x: this.cur.x + dx * rand(0.2, 0.5) + rand(-85, 85), y: this.cur.y + dy * rand(0.2, 0.5) + rand(-85, 85) };
    const c2: P = { x: this.cur.x + dx * rand(0.5, 0.8) + rand(-85, 85), y: this.cur.y + dy * rand(0.5, 0.8) + rand(-85, 85) };
    const steps = randInt(this.profile.steps[0], this.profile.steps[1]);
    for (let i = 1; i <= steps && this.running; i++) {
      if (cancelIfBusy && this.busy) return;
      const p = bezier(this.cur, c1, c2, dest, easeInOut(i / steps));
      try { await this.page.mouse.move(p.x, p.y); } catch { this.running = false; return; }
      this.cur = p;
      await sleep(rand(this.profile.moveStepMs[0], this.profile.moveStepMs[1]));
    }
    this.cur = dest;
  }

  private async pointOf(target: Locator | P): Promise<P | null> {
    if ("x" in target) return target;
    const box = await target.boundingBox().catch(() => null);
    if (!box) return null;
    return { x: box.x + box.width * rand(0.3, 0.7), y: box.y + box.height * rand(0.3, 0.7) };
  }

  async moveTo(x: number, y: number): Promise<void> { await this.travel({ x, y }, false); }

  /** Click HUMANO: aproximación con curva + hover (baja el risk score) y luego ACTÚA.
   *  Puntos crudos → mouse.down/up. Locators → locator.click().
   *  CRÍTICO: el reCAPTCHA vive en un OOPIF (iframe out-of-process). El mouse.down/up
   *  por coordenadas top-level NO llega al frame → el checkbox no se actúa. Solo
   *  locator.click() enruta el evento DENTRO del frame. Por eso, para un Locator, la
   *  aproximación es humana (curva+hover) pero la actuación va por locator.click(). */
  async click(target: Locator | P): Promise<void> {
    this.busy = true;
    try {
      const pt = await this.pointOf(target);
      // 1) Aproximación humana: mover el cursor real con curva + hover donde se pueda.
      if (pt) {
        await this.travel(pt, false);
        await sleep(rand(this.profile.hoverMs[0], this.profile.hoverMs[1]));
        try { await this.page.mouse.move(pt.x + rand(-2, 2), pt.y + rand(-2, 2)); } catch {}
      }
      // 2) Actuación real.
      if ("x" in target) {
        // Punto crudo: no hay Locator con que actuar → mouse.down/up.
        try { await this.page.mouse.down(); } catch {}
        await sleep(rand(this.profile.pressMs[0], this.profile.pressMs[1]));
        try { await this.page.mouse.up(); } catch {}
      } else {
        // Locator: actuar por locator.click() (funciona en OOPIF; el mouse crudo NO).
        // El hover humano ya ocurrió arriba. `delay` = presión real entre down y up.
        const delay = Math.round(rand(this.profile.pressMs[0], this.profile.pressMs[1]));
        await (target as Locator).click({ timeout: 8000, delay }).catch(() => {});
      }
    } finally { this.busy = false; }
  }

  /** Tipeo HUMANO: click para enfocar + tecla por tecla con timing variable + typo ocasional. */
  async type(field: Locator, text: string): Promise<void> {
    this.busy = true;
    try {
      await this.click(field);
      await sleep(rand(140, 380));
      for (const ch of text) {
        if (Math.random() < this.profile.typoProb) {
          const wrong = String.fromCharCode(ch.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
          try { await this.page.keyboard.type(wrong); } catch {}
          await sleep(rand(this.profile.typeMs[0], this.profile.typeMs[1]));
          try { await this.page.keyboard.press("Backspace"); } catch {}
          await sleep(rand(90, 210));
        }
        try { await this.page.keyboard.type(ch); } catch {}
        await sleep(rand(this.profile.typeMs[0], this.profile.typeMs[1]));
      }
    } finally { this.busy = false; }
  }

  /** Movimiento idle de fondo (cede el cursor con `busy` durante acciones deliberadas). */
  startIdle(): void {
    (async () => {
      await sleep(rand(300, 900));
      while (this.running) {
        if (this.busy) { await sleep(120); continue; }
        await this.travel({ x: rand(0.05 * this.W, 0.95 * this.W), y: rand(0.08 * this.H, 0.92 * this.H) }, true);
        await sleep(rand(this.profile.idlePauseMs[0], this.profile.idlePauseMs[1]));
        if (this.running && !this.busy && Math.random() < 0.35) {
          for (let j = 0; j < randInt(2, 4) && this.running && !this.busy; j++) {
            try { await this.page.mouse.move(this.cur.x + rand(-5, 5), this.cur.y + rand(-5, 5)); } catch { this.running = false; }
            await sleep(rand(25, 90));
          }
        }
      }
    })().catch(() => { /* nunca romper el flujo del RPA */ });
  }

  stop(): void { this.running = false; }
}
