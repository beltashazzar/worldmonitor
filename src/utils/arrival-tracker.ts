/**
 * Remembers when each map item first appeared, so only genuine arrivals are animated.
 *
 * Whatever is present at the first non-empty observation is the baseline and never counts as
 * new, so a page load (or the service worker's self-reload after a deploy) draws a quiet map.
 * A key that drops out of the data is forgotten, so if it comes back it counts as a new arrival.
 */
export const PULSE_WINDOW_MS = 10 * 60 * 1000;

export class ArrivalTracker {
  private firstSeen = new Map<string, number>(); // 0 = baseline, never new
  private primed = false;

  observe(keys: Iterable<string>, now = Date.now()): void {
    const current = new Set(keys);
    if (current.size === 0) return; // an empty or failed fetch must not prime the baseline
    for (const key of current) {
      if (!this.firstSeen.has(key)) this.firstSeen.set(key, this.primed ? now : 0);
    }
    for (const key of [...this.firstSeen.keys()]) {
      if (!current.has(key)) this.firstSeen.delete(key);
    }
    this.primed = true;
  }

  /** Milliseconds since the key arrived, or null if it is baseline, unknown or past the window. */
  age(key: string, now = Date.now()): number | null {
    const t = this.firstSeen.get(key);
    if (!t) return null;
    const age = now - t;
    return age < PULSE_WINDOW_MS ? age : null;
  }

  isNew(key: string, now = Date.now()): boolean {
    return this.age(key, now) !== null;
  }

  /** Keys still inside their pulse window, for detecting when the set of new items changes. */
  newKeys(now = Date.now()): string[] {
    const keys: string[] = [];
    for (const [key, t] of this.firstSeen) if (t && now - t < PULSE_WINDOW_MS) keys.push(key);
    return keys;
  }

  anyNew(now = Date.now()): boolean {
    for (const t of this.firstSeen.values()) {
      if (t && now - t < PULSE_WINDOW_MS) return true;
    }
    return false;
  }
}

/**
 * The 1 fps pulse: a four-step beat (small, mid, large, mid), one step per second.
 * At one frame a second a sine wave reads as jitter; discrete steps read as a deliberate beat.
 */
const BEAT = [0, 0.5, 1, 0.5];
export function pulseBeat(now = Date.now()): number {
  return BEAT[Math.floor(now / 1000) % BEAT.length]!;
}
