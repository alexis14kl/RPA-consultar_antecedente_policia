// core/Semaphore.ts — tracker de consultas activas/esperando (para /health).
// No bloquea: el limitador real es el TokenPool. Solo cuenta.
export class Semaphore {
  private _active = 0;
  private _waiting = 0;
  trackStart() { this._active++; }
  trackEnd()   { this._active = Math.max(0, this._active - 1); }
  trackWait()  { this._waiting++; }
  trackReady() { this._waiting = Math.max(0, this._waiting - 1); }
  get active(): number { return this._active; }
  get waiting(): number { return this._waiting; }
}
