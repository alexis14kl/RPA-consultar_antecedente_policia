// scrapers/CachingScraperProxy.ts — patrón PROXY.
// Sustituto que implementa la MISMA interfaz (IScraper) que el scraper real y controla
// el acceso al recurso caro (la consulta con captcha). Transparente para el cliente:
//   1) caché HIT  → devuelve lo guardado (NO toca el scraper real),
//   2) dedup      → si la misma cédula ya está en vuelo, reusa esa promesa,
//   3) MISS       → delega al real (con timeout) y guarda el resultado en caché.
import { IScraper } from "./IScraper";
import { ResultCache } from "../core/ResultCache";

export class CachingScraperProxy implements IScraper {
  private readonly enVuelo = new Map<string, Promise<any>>();

  constructor(
    private readonly real: IScraper,   // el sujeto real (AntecedentesScraper)
    private readonly cache: ResultCache,
    private readonly timeoutMs: number,
  ) {}

  async consultar(cedula: string, tipo: string): Promise<any> {
    const key = `${tipo}:${cedula}`;

    const cached = this.cache.get(key);
    if (cached) {
      console.log(`[CACHE] HIT ${tipo.toUpperCase()} ${cedula}`);
      return { ...cached, cached: true };
    }

    const enCurso = this.enVuelo.get(key);
    if (enCurso) {
      console.log(`[DEDUP] ${cedula} ya en vuelo — reusando resultado`);
      return enCurso;
    }

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: consulta excedió ${this.timeoutMs / 1000}s`)), this.timeoutMs),
    );
    const p = Promise.race([this.real.consultar(cedula, tipo), timeout]);
    this.enVuelo.set(key, p);
    p.then(
      (result) => { this.enVuelo.delete(key); this.cache.set(key, result); },
      () => this.enVuelo.delete(key),
    );
    return p;
  }
}
