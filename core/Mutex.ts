// core/Mutex.ts — mutex de sesión. Serializa el tramo enviar→leer contra la policía:
// todas las páginas del pool comparten el JSESSIONID del context, así que dos submits
// concurrentes cruzarían resultados. El pre-resuelto de captchas sigue en paralelo.
export class Mutex {
  private cola: Promise<void> = Promise.resolve();
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.cola;
    this.cola = prev.then(() => next);
    await prev;
    return release;
  }
}
