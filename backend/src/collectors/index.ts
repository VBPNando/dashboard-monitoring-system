import type { Collector, ConnConfig } from './types.js';
import { MariaDbCollector } from './mariadb.js';
import { PostgresCollector } from './postgres.js';
import { MssqlCollector } from './mssql.js';
import { SqliteCollector } from './sqlite.js';

/** Factory: satu interface, banyak engine (Strategy pattern). Tambah engine baru di sini. */
export function createCollector(cfg: ConnConfig): Collector {
  switch (cfg.engine) {
    case 'mariadb':
      return new MariaDbCollector(cfg);
    case 'postgres':
      return new PostgresCollector(cfg);
    case 'mssql':
      return new MssqlCollector(cfg);
    case 'sqlite':
      return new SqliteCollector(cfg);
  }
}

export * from './types.js';
