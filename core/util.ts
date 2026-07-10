// core/util.ts — helpers chicos compartidos.
export function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
export const rand = (min: number, max: number): number => Math.random() * (max - min) + min;
