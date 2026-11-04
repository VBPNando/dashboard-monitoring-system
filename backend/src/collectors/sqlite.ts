import { DatabaseSync } from 'node:sqlite'; // SQLite bawaan Node.js 22.13+: tanpa compile native
import { existsSync, statSync } from 'node:fs';
import type { Collector, ConnConfig, RawSample } from './types.js';

/**
 * SQLite.
 * SQLite adalah database berbasis file (embedded): tidak ada host, port,
 * user, password, maupun counter query/koneksi seperti server RDBMS.
 * Karena itu yang bisa dipantau secara jujur adalah ukuran & kesehatan file:
 *   - ukuran file DB dan WAL, page_count, freelist_count
 * QPS & active connections dikirim null → UI menampilkan "tidak tersedia".
 * Jika butuh QPS SQLite, aplikasi pemilik DB harus mengirim metriknya sendiri
 * (mis. lewat endpoint push / agen kecil di server tersebut).
 */
export class SqliteCollector implements Collector {
  private db?: DatabaseSync;

  constructor(private cfg: ConnConfig) {}

  async connect() {
    if (!existsSync(this.cfg.filePath!)) throw new Error(`File tidak ditemukan: ${this.cfg.filePath}`);
    this.db = new DatabaseSync(this.cfg.filePath!, { readOnly: true });
    this.pragma('schema_version'); // memastikan file benar-benar database SQLite
  }

  private pragma(name: string): number {
    const row = this.db!.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return Number(row ? Object.values(row)[0] : 0);
  }

  async sample(): Promise<RawSample> {
    const pageCount = this.pragma('page_count');
    const pageSize = this.pragma('page_size');
    const freelist = this.pragma('freelist_count');
    let walBytes = 0;
    try {
      walBytes = statSync(this.cfg.filePath + '-wal').size;
    } catch {
      /* tidak dalam mode WAL */
    }
    return {
      ts: Date.now(),
      queriesTotal: null,
      activeConnections: null,
      totalConnections: null,
      extra: {
        dbBytes: pageCount * pageSize,
        walBytes,
        freePages: freelist,
      },
    };
  }

  async close() {
    this.db?.close();
  }
}
