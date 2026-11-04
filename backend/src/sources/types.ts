/** Jenis sumber selain database. Database tetap memakai collectors/ (engine mariadb/postgres/mssql/sqlite). */
export type DeviceKind = 'proxmox' | 'pbs' | 'synology' | 'abb' | 'isp' | 'fortigate' | 'mikrotik';

/** Pengaturan tambahan per jenis (disimpan terenkripsi bersama koneksi). */
export interface DeviceOptions {
  /** Proxmox/Synology/ABB/FortiGate: pakai https (default true) · MikroTik: default false */
  https?: boolean;
  /** Proxmox: batasi ke satu node (kosong = semua node) */
  node?: string;
  /** ISP */
  provider?: string;
  slaTarget?: number; // persen, mis. 99.5
  intervalSec?: number; // jeda antar-ping
  method?: 'ping' | 'tcp';
  tcpPort?: number;
  latencyWarnMs?: number;
  /** ABB / PBS: alert bila tidak ada backup sukses lebih dari sekian jam */
  staleHours?: number;
  /** FortiGate: VDOM (kosong = root/bawaan) */
  vdom?: string;
}

export interface DeviceConfig {
  id: string;
  name: string;
  kind: DeviceKind;
  host: string;
  port?: number;
  username?: string;
  /** Proxmox: secret API token · FortiGate: API key · Synology/ABB/MikroTik: password */
  password?: string;
  options: DeviceOptions;
}

/** Hasil satu kali pengecekan: deret angka untuk grafik + data lengkap untuk panel. */
export interface DeviceSample {
  /** Angka yang disimpan sebagai riwayat & digambar di grafik */
  series: Record<string, number | null>;
  /** Data lengkap untuk panel (daftar VM, volume, tugas backup, insiden, dst.) */
  data: Record<string, unknown>;
  /** Kondisi alert yang diperiksa pada sampel ini */
  checks: Check[];
}

export interface Check {
  rule: string;
  /** Berapa sampel berturut-turut sebelum alert muncul (default 1) */
  raiseAfter?: number;
  /** Berapa sampel normal berturut-turut sebelum alert dianggap selesai (default 5) */
  clearAfter?: number;
  hit: { severity: 'critical' | 'warning'; title: string; message: string } | null;
}

export interface DeviceSource {
  /** Interval pengecekan (ms) */
  readonly intervalMs: number;
  /** Uji koneksi & hak akses (dipakai tombol "Tes koneksi") */
  test(): Promise<string>;
  sample(): Promise<DeviceSample>;
  close(): Promise<void>;
  /** Respons mentah terakhir (untuk diagnosa API yang tidak terdokumentasi) */
  raw?(): unknown;
}

export const level = (v: number | null | undefined, warn: number, crit: number) =>
  v == null ? null : v >= crit ? ('critical' as const) : v >= warn ? ('warning' as const) : null;

export const pct = (used?: number | null, total?: number | null) =>
  used == null || !total ? null : Math.round((used / total) * 1000) / 10;

export const r1 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
