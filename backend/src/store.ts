import { DatabaseSync } from 'node:sqlite'; // SQLite bawaan Node.js 22.13+: tanpa compile native
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './config.js';
import { decrypt, encrypt } from './crypto.js';
import type { ConnConfig, Engine } from './collectors/types.js';
import type { DeviceConfig, DeviceKind, DeviceOptions } from './sources/types.js';

/**
 * Penyimpanan konfigurasi (data/dbmon.sqlite). Satu tabel untuk semua sumber:
 *  - engine mariadb/postgres/mssql/sqlite → database
 *  - engine proxmox/pbs/synology/abb/isp/fortigate/mikrotik → perangkat (pengaturan tambahan di options_json)
 * Password / secret token selalu terenkripsi AES-256-GCM.
 */
const db = new DatabaseSync(join(DATA_DIR, 'dbmon.sqlite'));
db.exec('PRAGMA journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    engine       TEXT NOT NULL,
    host         TEXT,
    port         INTEGER,
    username     TEXT,
    password_enc TEXT,
    database     TEXT,
    file_path    TEXT,
    created_at   INTEGER NOT NULL
  )
`);

// Migrasi bertahap (data lama tetap aman)
const cols = new Set((db.prepare('PRAGMA table_info(connections)').all() as { name: string }[]).map((c) => c.name));
if (!cols.has('agent_url')) db.exec('ALTER TABLE connections ADD COLUMN agent_url TEXT');
if (!cols.has('agent_token_enc')) db.exec('ALTER TABLE connections ADD COLUMN agent_token_enc TEXT');
if (!cols.has('options_json')) db.exec('ALTER TABLE connections ADD COLUMN options_json TEXT');

const DB_ENGINES = new Set<string>(['mariadb', 'postgres', 'mssql', 'sqlite']);
export const isDbEngine = (e: string): e is Engine => DB_ENGINES.has(e);

interface Row {
  id: string;
  name: string;
  engine: string;
  host: string | null;
  port: number | null;
  username: string | null;
  password_enc: string | null;
  database: string | null;
  file_path: string | null;
  agent_url: string | null;
  agent_token_enc: string | null;
  options_json: string | null;
}

export type Source = { type: 'db'; cfg: ConnConfig } | { type: 'device'; cfg: DeviceConfig };

/** Versi aman untuk browser: tanpa password, secret, maupun token. */
export interface PublicConn {
  id: string;
  name: string;
  engine: string;
  host?: string;
  port?: number;
  username?: string;
  database?: string;
  filePath?: string;
  agentUrl?: string;
  hasAgent: boolean;
  options?: DeviceOptions;
}

export function toPublic(c: ConnConfig | DeviceConfig): PublicConn {
  if ('kind' in c) {
    return { id: c.id, name: c.name, engine: c.kind, host: c.host, port: c.port, username: c.username, options: c.options, hasAgent: false };
  }
  const { password: _p, agentToken: _t, ...pub } = c;
  return { ...pub, hasAgent: !!c.agentUrl };
}

const rows = () => db.prepare('SELECT * FROM connections ORDER BY created_at').all() as unknown as Row[];

export function listPublic(): PublicConn[] {
  return rows().map((r) => toPublic(toSource(r, false).cfg));
}

/** Semua sumber lengkap dengan secret (untuk memulai pemantauan). */
export function listSources(): Source[] {
  const out: Source[] = [];
  for (const r of rows()) {
    try {
      out.push(toSource(r, true));
    } catch {
      // Biasanya karena master.key berganti/hilang: lewati, jangan matikan server.
      console.error(`[dbmon] Password "${r.name}" tidak bisa dibuka (master.key berubah?). Hapus & daftarkan ulang.`);
    }
  }
  return out;
}

export function getSource(id: string): Source | undefined {
  const r = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as unknown as Row | undefined;
  return r ? toSource(r, true) : undefined;
}

/** Khusus database (dipakai pengaturan agen CPU/RAM). */
export function getWithSecrets(id: string): ConnConfig | undefined {
  const s = getSource(id);
  return s?.type === 'db' ? s.cfg : undefined;
}

export function insert(input: Omit<ConnConfig, 'id'>): ConnConfig {
  const cfg: ConnConfig = { ...input, id: randomUUID() };
  write({
    id: cfg.id,
    name: cfg.name,
    engine: cfg.engine,
    host: cfg.host ?? null,
    port: cfg.port ?? null,
    username: cfg.username ?? null,
    password_enc: cfg.password != null ? encrypt(cfg.password) : null,
    database: cfg.database ?? null,
    file_path: cfg.filePath ?? null,
    agent_url: cfg.agentUrl ?? null,
    agent_token_enc: cfg.agentToken ? encrypt(cfg.agentToken) : null,
    options_json: null,
  });
  return cfg;
}

export function insertDevice(input: Omit<DeviceConfig, 'id'>): DeviceConfig {
  const cfg: DeviceConfig = { ...input, id: randomUUID() };
  write({
    id: cfg.id,
    name: cfg.name,
    engine: cfg.kind,
    host: cfg.host,
    port: cfg.port ?? null,
    username: cfg.username ?? null,
    password_enc: cfg.password ? encrypt(cfg.password) : null,
    database: null,
    file_path: null,
    agent_url: null,
    agent_token_enc: null,
    options_json: JSON.stringify(cfg.options ?? {}),
  });
  return cfg;
}

function write(r: Row) {
  db.prepare(
    `INSERT INTO connections (id, name, engine, host, port, username, password_enc, database, file_path,
                              agent_url, agent_token_enc, options_json, created_at)
     VALUES (@id, @name, @engine, @host, @port, @username, @password_enc, @database, @file_path,
             @agent_url, @agent_token_enc, @options_json, @created_at)`,
  ).run({ ...r, created_at: Date.now() });
}

/** Pasang / ganti / lepas agen (url kosong = lepas). */
export function updateAgent(id: string, agentUrl: string | null, agentToken: string | null) {
  return (
    db
      .prepare('UPDATE connections SET agent_url = ?, agent_token_enc = ? WHERE id = ?')
      .run(agentUrl, agentUrl && agentToken ? encrypt(agentToken) : null, id).changes > 0
  );
}

export function remove(id: string) {
  return db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
}

function toSource(r: Row, withSecret: boolean): Source {
  const secret = withSecret && r.password_enc ? decrypt(r.password_enc) : undefined;
  if (isDbEngine(r.engine)) {
    return {
      type: 'db',
      cfg: {
        id: r.id,
        name: r.name,
        engine: r.engine,
        host: r.host ?? undefined,
        port: r.port ?? undefined,
        username: r.username ?? undefined,
        password: secret,
        database: r.database ?? undefined,
        filePath: r.file_path ?? undefined,
        agentUrl: r.agent_url ?? undefined,
        agentToken: withSecret && r.agent_token_enc ? decrypt(r.agent_token_enc) : undefined,
      },
    };
  }
  let options: DeviceOptions = {};
  try {
    options = r.options_json ? (JSON.parse(r.options_json) as DeviceOptions) : {};
  } catch {
    /* opsi rusak → pakai default */
  }
  return {
    type: 'device',
    cfg: {
      id: r.id,
      name: r.name,
      kind: r.engine as DeviceKind,
      host: r.host ?? '',
      port: r.port ?? undefined,
      username: r.username ?? undefined,
      password: secret,
      options,
    },
  };
}
