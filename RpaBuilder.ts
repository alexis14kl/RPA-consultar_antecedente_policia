// RpaBuilder.ts — patrón BUILDER: ensambla el grafo de objetos del RPA en UN solo lugar.
// Separa "cómo se construye" (acá) de "qué hace" (RpaServer). TODAS las dependencias entre
// clases (quién recibe qué en su constructor) viven en este archivo: si mañana cambia el
// constructor de una superclase (WebScraper) o de cualquier pieza, TypeScript marca el error
// ACÁ, en un solo lugar — no desperdigado por todo el código.
import { CdpConnection } from "./core/CdpConnection";
import { ResultCache } from "./core/ResultCache";
import { TokenPool } from "./core/TokenPool";
import { AntecedentesScraper } from "./scrapers/AntecedentesScraper";
import { CachingScraperProxy } from "./scrapers/CachingScraperProxy";
import { RpaServer, RpaConfig } from "./RpaServer";

export class RpaBuilder {
  private cfg?: RpaConfig;

  /** Config del RPA (interfaz fluida). */
  withConfig(cfg: RpaConfig): this { this.cfg = cfg; return this; }

  /** Ensambla el grafo completo y devuelve un RpaServer listo para .start(). */
  build(): RpaServer {
    if (!this.cfg) throw new Error("RpaBuilder: falta withConfig() antes de build()");
    const cfg = this.cfg;

    // El orden resuelve la dependencia circular pool↔scraper:
    //  - cdp necesita al pool (callback de "context muerto") → capturado por closure (late-bound),
    //  - pool necesita al scraper (solveOne/validar) → creado antes,
    //  - scraper necesita al pool (getToken) → inyectado con setPool.
    let pool!: TokenPool;
    const cdp = new CdpConnection(cfg.cdpPort, cfg.urlSite, () => pool.descartarPoolMuerto());
    const cache = new ResultCache(cfg.cacheTtlMs);
    const scraper = new AntecedentesScraper(cdp, cfg);
    pool = new TokenPool(
      cdp,
      (page, hm, label) => scraper.solveOne(page, hm, label), // Strategy: CÓMO resolver el captcha
      (page) => scraper.rcResuelto(page),                     // CÓMO validar un token
      { ...cfg.pool, maxWorkers: cfg.maxWorkers },
    );
    scraper.setPool(pool);
    const api = new CachingScraperProxy(scraper, cache, cfg.consultaTimeoutMs); // Proxy (caché+dedup)

    return new RpaServer(cfg, { cdp, cache, pool, api });
  }
}
