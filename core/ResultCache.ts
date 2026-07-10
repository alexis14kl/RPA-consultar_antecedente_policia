// core/ResultCache.ts — caché de resultados con TTL (evita reconsultar la misma cédula).
interface CacheEntry { result: any; expiresAt: number; }

export class ResultCache {
  private store = new Map<string, CacheEntry>();
  private _hits = 0;
  private _misses = 0;

  constructor(private readonly ttlMs: number, private readonly maxEntries = 1000) {}

  get(key: string): any | null {
    const entry = this.store.get(key);
    if (!entry) { this._misses++; return null; }
    if (Date.now() > entry.expiresAt) { this.store.delete(key); this._misses++; return null; }
    this._hits++;
    return entry.result;
  }

  set(key: string, result: any): void {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value; // FIFO simple
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { result, expiresAt: Date.now() + this.ttlMs });
  }

  get stats() {
    return { entradas: this.store.size, hits: this._hits, misses: this._misses, ttl_min: this.ttlMs / 60000 };
  }
}
