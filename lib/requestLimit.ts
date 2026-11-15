import { LRUCache } from "lru-cache";
import { monotonicMs } from "./clock";

export function createRequestLimit(time = monotonicMs, maxPerMinute = 10) {
  const windows = new LRUCache<string, { start: number; count: number }>({ max: 10_000 });
  const active = new Set<string>();
  return function acquire(userId: string): { release: () => void } | { retryAfter: number } {
    if (active.has(userId)) return { retryAfter: 1 };
    const instant = time();
    let window = windows.get(userId);
    if (!window || instant - window.start >= 60_000) window = { start: instant, count: 0 };
    if (window.count >= maxPerMinute) return { retryAfter: Math.max(1, Math.ceil((60_000 - (instant - window.start)) / 1000)) };
    window.count++;
    windows.set(userId, window);
    active.add(userId);
    let released = false;
    return { release: () => { if (!released) { released = true; active.delete(userId); } } };
  };
}

export const acquireChat = createRequestLimit();
