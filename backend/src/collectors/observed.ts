import type { SessionInfo, SlowQuery } from './types.js';

/**
 * Ubah query menjadi "pola" supaya query yang sama dengan nilai berbeda terhitung satu:
 *   SELECT * FROM orders WHERE id = 42 AND status = 'x'  →  SELECT * FROM orders WHERE id = ? AND status = ?
 */
export function normalizeQuery(q: string) {
  return q
    .replace(/'(?:[^'\\]|\\.|'')*'/g, '?')
    .replace(/"(?:[^"\\]|\\.)*"/g, '?')
    .replace(/\b0x[0-9a-f]+\b/gi, '?')
    .replace(/\b\d+(\.\d+)?\b/g, '?')
    .replace(/\(\s*\?(\s*,\s*\?)+\s*\)/g, '(...)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/**
 * Pencatat slow query dari query berjalan yang teramati — dipakai bila statistik query
 * database tidak aktif (mis. performance_schema OFF di MariaDB XAMPP).
 * Diurutkan menurut durasi terlama yang pernah teramati.
 */
export class ObservedSlowQueries {
  private map = new Map<string, { query: string; maxMs: number; seen: number; lastSeen: number }>();
  private lastIds = new Map<string, string>(); // session id → pola query terakhir (agar 1 eksekusi tidak dihitung berkali-kali)

  constructor(
    private minMs = 200,
    private capacity = 300,
  ) {}

  observe(sessions: SessionInfo[]) {
    const now = Date.now();
    const current = new Map<string, string>();
    for (const s of sessions) {
      if (!s.query || s.durationMs < this.minMs) continue;
      const key = normalizeQuery(s.query);
      current.set(s.id, key);
      const e = this.map.get(key);
      const isNewExecution = this.lastIds.get(s.id) !== key;
      if (e) {
        e.maxMs = Math.max(e.maxMs, s.durationMs);
        if (isNewExecution) e.seen++;
        e.lastSeen = now;
      } else {
        this.map.set(key, { query: key, maxMs: s.durationMs, seen: 1, lastSeen: now });
      }
    }
    this.lastIds = current;
    if (this.map.size > this.capacity) {
      // Buang yang paling cepat & paling lama tidak terlihat
      const sorted = [...this.map.entries()].sort((a, b) => a[1].maxMs - b[1].maxMs || a[1].lastSeen - b[1].lastSeen);
      for (const [k] of sorted.slice(0, this.map.size - this.capacity)) this.map.delete(k);
    }
  }

  top(n = 5): SlowQuery[] {
    return [...this.map.values()]
      .sort((a, b) => b.maxMs - a.maxMs)
      .slice(0, n)
      .map((e) => ({ query: e.query, calls: e.seen, avgMs: null, totalMs: null, maxMs: e.maxMs }));
  }
}

/** Antrian sederhana: query collector dijalankan berurutan agar penghitung query milik monitor akurat. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}
