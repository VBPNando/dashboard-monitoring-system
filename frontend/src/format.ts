/** Angka gaya Indonesia; ≥ 10.000 diringkas (12,3 rb / 4,5 jt). */
export function fmtNum(v: number | null | undefined, decimals?: number) {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  if (abs >= 10_000) return `${(v / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} rb`;
  const d = decimals ?? (Number.isInteger(v) ? 0 : 1);
  return v.toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Durasi: 350 ms · 1,2 dtk · 3 mnt · 2 jam */
export function fmtMs(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} dtk`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)} mnt`;
  return `${(ms / 3600_000).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jam`;
}

export function fmtBytes(b: number | null | undefined) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString('id-ID', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}

/** "baru saja", "3 mnt lalu", "2 jam lalu" */
export function fmtAgo(ts: number) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'baru saja';
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  return `${Math.round(s / 86400)} hari lalu`;
}

/** Rapikan teks query untuk ditampilkan satu baris. */
export const oneLine = (q: string) => q.replace(/\s+/g, ' ').trim();

/** Laju byte per detik: 1,2 MB/dtk */
export const fmtRate = (b: number | null | undefined) => (b == null ? '—' : `${fmtBytes(b)}/dtk`);

/** Lama menyala dari detik: "12 hari 3 jam", "5 jam 20 mnt" */
export function fmtUptime(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} hari ${h} jam`;
  if (h) return `${h} jam ${m} mnt`;
  return `${m} mnt`;
}

/** Durasi panjang dalam menit/jam: "45 mnt", "3 jam 10 mnt" (untuk downtime & jatah SLA) */
export function fmtDur(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const neg = ms < 0;
  const a = Math.abs(ms);
  let t: string;
  if (a < 60_000) t = `${Math.round(a / 1000)} dtk`;
  else if (a < 3600_000) t = `${Math.round(a / 60_000)} mnt`;
  else t = `${Math.floor(a / 3600_000)} jam ${Math.round((a % 3600_000) / 60_000)} mnt`;
  return neg ? `−${t}` : t;
}

/** Jam & tanggal singkat: "22 Okt 14:05" */
export const fmtWhen = (ts: number | null | undefined) =>
  ts == null ? '—' : new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
