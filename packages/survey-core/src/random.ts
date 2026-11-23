import type { ChoiceOption } from './schema';

/** FNV-1a 32-bit hash: turns a seed string into a number. */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Order options for display. With `randomize`, the order is shuffled but stable for a given seed
 * (the respondent's response key + question key), so reloading or resuming shows the same order.
 * "Other" and exclusive options ("None of the above") always stay at the end.
 */
export function orderOptions(options: ChoiceOption[], randomize: boolean, seed: string): ChoiceOption[] {
  if (!randomize) return options;
  const pinned = options.filter((o) => o.isOther || o.exclusive);
  const shuffled = options.filter((o) => !o.isOther && !o.exclusive);
  const random = prng(hash(seed));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return [...shuffled, ...pinned];
}
