// core/TokenPool.ts — patrón OBJECT POOL.
// Mantiene un conjunto de "tokens" (páginas con el reCAPTCHA ya resuelto — caras de
// producir) listos para consumir. Los solvers los producen en background; getToken()
// los reparte (LIFO = el más fresco). No sabe NADA de captchas: recibe `solveOne`
// (cómo resolver — Strategy/DI) y `validarToken` del scraper. Incluye:
//  - objetivo ADAPTATIVO a la demanda (no quemar IP en idle),
//  - circuit-breaker (pausa si N fallos seguidos),
//  - reaper anti-leak (cierra páginas huérfanas),
//  - warmup acotado (no atar la disponibilidad al pool).
import { Page } from "playwright";
import { CdpConnection } from "./CdpConnection";
import { HumanMouse } from "./HumanMouse";
import { Semaphore } from "./Semaphore";
import { esperar } from "./util";

interface PoolToken { page: Page; solvedAt: number; expiresAt: number; }

export interface TokenPoolConfig {
  target: number;          // tokens objetivo con demanda
  idle: number;            // tokens objetivo en idle (anti-quemado)
  solvers: number;         // cantidad de solvers en paralelo
  maxWorkers: number;      // para el log/health
  demandWindowMs: number;  // ventana de "demanda reciente"
  tokenMaxAgeMs: number;   // vida del token
  tokenMinBufferMs: number;// margen antes del vencimiento
  warmupMs: number;        // espera tibia al arrancar
  waitMs: number;          // máx que getToken espera → si no, 503
  reaperIntervalMs: number;
  maxPages: number;
  circuitFails: number;    // fallos seguidos para abrir el circuito
  circuitCooldownMs: number;
}

/** Solve del captcha sobre una página dada (lo provee el scraper). */
export type SolveOne = (page: Page, hm: HumanMouse, label: string) => Promise<boolean>;
/** Valida que un token siga resuelto antes de repartirlo (lo provee el scraper). */
export type ValidateToken = (page: Page) => Promise<boolean>;

export class TokenPool {
  readonly semaphore = new Semaphore();
  private pool: PoolToken[] = [];
  private inFlight = new Set<Page>();
  private lastDemandAt = 0;
  private circuitFails = 0;
  private circuitOpenUntil = 0;

  constructor(
    private readonly cdp: CdpConnection,
    private readonly solveOne: SolveOne,
    private readonly validarToken: ValidateToken,
    private readonly cfg: TokenPoolConfig,
  ) {}

  // ── Arranque: lanza los solvers escalonados + el reaper ──────────────────
  start(): void {
    for (let sid = 0; sid < this.cfg.solvers; sid++) {
      const launch = (id: number) => {
        this.runSolver(id).catch((e) => {
          console.error(`[POOL-${id}] Crashed: ${e.message} — reiniciando en 5s`);
          setTimeout(() => launch(id), 5000);
        });
      };
      setTimeout(() => launch(sid), sid * 5000);
    }
    setInterval(() => { this.reap().catch(() => {}); }, this.cfg.reaperIntervalMs);
  }

  // ── Warmup acotado: espera el 1er token para arrancar tibio, pero NO bloquea
  //    la apertura del puerto. Devuelve cuántos tokens hay al terminar. ────────
  async warmup(): Promise<number> {
    const deadline = Date.now() + this.cfg.warmupMs;
    while (this.pool.length === 0 && Date.now() < deadline) await esperar(500);
    return this.pool.length;
  }

  // ── Loop de un solver (Object Pool: produce tokens hasta el objetivo) ──────
  private async runSolver(sid: number): Promise<void> {
    const label = `POOL-${sid}`;
    console.log(`[${label}] Solver iniciado — objetivo: ${this.cfg.target} tokens listos`);
    while (true) {
      try {
        this.descartarExpirados(label);

        if (Date.now() < this.circuitOpenUntil) { await esperar(2000); continue; } // circuito abierto

        const target = (Date.now() - this.lastDemandAt < this.cfg.demandWindowMs) ? this.cfg.target : this.cfg.idle;
        if (this.pool.length >= target) { await esperar(500); continue; }

        console.log(`[${label}] Resolviendo CAPTCHA... (pool: ${this.pool.length}/${this.cfg.target})`);
        const page = await this.cdp.newPage();
        this.inFlight.add(page);
        const hm = new HumanMouse(page);
        hm.startIdle();
        try {
          const ok = await this.solveOne(page, hm, label);
          hm.stop();
          if (ok) {
            this.circuitFails = 0; // éxito → cerrar el circuito
            const solvedAt = Date.now();
            this.pool.push({ page, solvedAt, expiresAt: solvedAt + this.cfg.tokenMaxAgeMs - this.cfg.tokenMinBufferMs });
            console.log(`[${label}] Token listo ✓ (pool: ${this.pool.length}/${this.cfg.target})`);
          } else {
            await this.closeSafe(page);
            this.registrarFallo(label);
            console.log(`[${label}] CAPTCHA no resuelto — reintentando en 3s`);
            await esperar(3000);
          }
        } catch (e) {
          hm.stop();
          await this.closeSafe(page);
          this.registrarFallo(label);
          console.log(`[${label}] Error: ${(e as Error).message} — reintentando en 3s`);
          await esperar(3000);
        } finally {
          this.inFlight.delete(page);
        }
      } catch (e) {
        console.error(`[${label}] Error inesperado: ${(e as Error).message}`);
        await esperar(5000);
      }
    }
  }

  // ── Repartir un token (espera si el pool está vacío; 503 al vencer waitMs) ──
  async getToken(): Promise<{ page: Page; expiresAt: number }> {
    this.lastDemandAt = Date.now();
    let waited = false;
    const deadline = Date.now() + this.cfg.waitMs;
    while (true) {
      while (this.pool.length > 0 && Date.now() > this.pool[0].expiresAt) {
        const t = this.pool.shift()!;
        await t.page.close().catch(() => {});
        console.log("[POOL] Token expirado descartado");
      }
      if (this.pool.length > 0) {
        const t = this.pool.pop()!; // LIFO → el más fresco
        this.inFlight.add(t.page);  // fuera de pool[] → protegido del reaper
        if (!(await this.validarToken(t.page))) {
          this.inFlight.delete(t.page);
          await this.closeSafe(t.page);
          console.log("[POOL] Token inválido descartado (validarToken=false)");
          continue;
        }
        if (waited) this.semaphore.trackReady();
        return { page: t.page, expiresAt: t.expiresAt }; // el consumidor lo cierra con discard()
      }
      if (Date.now() > deadline) {
        if (waited) this.semaphore.trackReady();
        const err: any = new Error("Sin tokens disponibles (pool vacío) — reintentá en unos segundos");
        err.poolUnavailable = true; // → 503 (no 500, no cuelga)
        throw err;
      }
      if (!waited) { this.semaphore.trackWait(); waited = true; }
      await esperar(300);
    }
  }

  /** El consumidor devuelve y cierra la página del token al terminar. */
  async discard(page: Page): Promise<void> { this.inFlight.delete(page); await this.closeSafe(page); }

  // ── Circuit-breaker ───────────────────────────────────────────────────────
  registrarFallo(label: string): void {
    this.circuitFails++;
    if (this.circuitFails >= this.cfg.circuitFails && Date.now() >= this.circuitOpenUntil) {
      this.circuitOpenUntil = Date.now() + this.cfg.circuitCooldownMs;
      console.warn(`[CIRCUIT] ⛔ abierto (${label}) — ${this.circuitFails} captchas fallidos seguidos; pauso solvers ${this.cfg.circuitCooldownMs / 1000}s (no quemar IP).`);
      this.circuitFails = 0;
    }
  }
  /** Reset externo del circuito (lo llama el proxy_watchdog tras rotar la IP). */
  resetCircuit(): boolean {
    const estaba = Date.now() < this.circuitOpenUntil;
    this.circuitOpenUntil = 0;
    this.circuitFails = 0;
    if (estaba) console.log("[CIRCUIT] ✅ reset externo (post-rotación) — solvers reanudan con la IP nueva");
    return estaba;
  }

  // ── Limpieza ──────────────────────────────────────────────────────────────
  private descartarExpirados(label: string): void {
    const now = Date.now();
    let expired = 0;
    for (let i = this.pool.length - 1; i >= 0; i--) {
      if (now > this.pool[i].expiresAt) {
        this.pool[i].page.close().catch(() => {});
        this.pool.splice(i, 1);
        expired++;
      }
    }
    if (expired > 0) console.log(`[${label}] ${expired} token(s) expirados (pool: ${this.pool.length})`);
  }

  private async closeSafe(page: Page): Promise<void> {
    await Promise.race([page.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  }

  private async reap(): Promise<void> {
    const ctx = this.cdp.context;
    if (!ctx) return;
    const legit = new Set<Page>(this.pool.map((t) => t.page));
    for (const p of this.inFlight) legit.add(p);
    let closed = 0;
    for (const p of ctx.pages()) {
      if (legit.has(p)) continue;
      await this.closeSafe(p);
      closed++;
    }
    const remaining = ctx.pages().length;
    if (closed > 0) console.log(`[REAPER] cerró ${closed} página(s) huérfana(s) — abiertas: ${remaining} (pool: ${this.pool.length}, inFlight: ${this.inFlight.size})`);
    else if (remaining > this.cfg.maxPages) console.warn(`[REAPER] ⚠️ ${remaining} páginas abiertas (esperado ≤${this.cfg.maxPages})`);
  }

  /** Descarta el pool muerto (páginas de un Chrome que ya no existe). Lo llama la CdpConnection al desconectarse. */
  descartarPoolMuerto(): void { this.pool.length = 0; this.inFlight.clear(); }

  // ── Estado para /health ───────────────────────────────────────────────────
  get stats() {
    return {
      pool: this.pool.length,
      pool_target: this.cfg.target,
      activas: this.semaphore.active,
      esperando: this.semaphore.waiting,
      max_workers: this.cfg.maxWorkers,
      circuito: {
        abierto: Date.now() < this.circuitOpenUntil,
        fails: this.circuitFails,
        reabre_en_s: Date.now() < this.circuitOpenUntil ? Math.ceil((this.circuitOpenUntil - Date.now()) / 1000) : 0,
      },
    };
  }
}
