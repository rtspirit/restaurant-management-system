// Small deterministic helpers. No Math.random anywhere in the seed.

/** 32-bit FNV-1a hash of a string, used to seed generators from readable keys. */
export const hashString = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

export type Rng = {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  between(min: number, max: number): number;
  /** Integer in [min, max], both ends included. */
  int(min: number, max: number): number;
  /** 1 plus or minus `spread` (uniform). */
  jitter(spread: number): number;
  pick<T>(items: readonly T[]): T;
};

/** mulberry32: tiny, fast, good enough for believable demo numbers. Same key, same sequence. */
export const rngFor = (key: string): Rng => {
  let a = hashString(key);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    between: (min, max) => min + (max - min) * next(),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    jitter: (spread) => 1 - spread + 2 * spread * next(),
    pick: (items) => {
      if (items.length === 0) throw new Error("Nothing to pick from");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
  };
};

/**
 * Splits a whole number of cents into parts proportional to `weights`, exactly (largest remainder).
 * The parts always add up to `total`. Weights must be positive.
 */
export const allocate = (total: number, weights: readonly number[]): number[] => {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("allocate: total must be a whole, non-negative number");
  if (weights.length === 0) throw new Error("allocate: no weights");
  if (weights.some((w) => !(w > 0) || !Number.isFinite(w))) throw new Error("allocate: weights must be positive");
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((x, y) => y.frac - x.frac || x.i - y.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) {
    const i = (order[k] as { i: number }).i;
    parts[i] = (parts[i] as number) + 1;
  }
  return parts;
};

/** Sum of a list of whole numbers. */
export const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

const DAY_MS = 86_400_000;

/** Parses YYYY-MM-DD as a UTC calendar date. Throws on anything else. */
export const parseDate = (iso: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Not a date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`Not a date: ${iso}`);
  return d;
};

export const formatDate = (d: Date): string => d.toISOString().slice(0, 10);

export const addDays = (iso: string, days: number): string => formatDate(new Date(parseDate(iso).getTime() + days * DAY_MS));

/** 0 = Monday ... 6 = Sunday. */
export const weekdayIndex = (iso: string): number => (parseDate(iso).getUTCDay() + 6) % 7;
