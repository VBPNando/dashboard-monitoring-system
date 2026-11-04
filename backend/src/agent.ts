import type { HostMetrics } from './collectors/types.js';

/** Ambil CPU, RAM & disk dari Monitoring Agent di server database. */
export async function fetchAgent(url: string, token: string, timeoutMs = 2500): Promise<HostMetrics> {
  const base = url.replace(/\/+$/, '');
  const res = await fetch(`${base}/metrics`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401) throw new Error('Token agen salah');
  if (res.status === 403) throw new Error('IP Dashboard Monitoring System tidak diizinkan oleh agen (DBMON_AGENT_ALLOW)');
  if (!res.ok) throw new Error(`Agen membalas HTTP ${res.status}`);
  const j = (await res.json()) as {
    cpuPct: number | null;
    memory?: { pct: number; usedBytes: number; totalBytes: number };
    disk?: { pct: number } | null;
    hostname?: string;
  };
  return {
    cpuPct: j.cpuPct ?? null,
    memPct: j.memory?.pct ?? null,
    memUsedBytes: j.memory?.usedBytes,
    memTotalBytes: j.memory?.totalBytes,
    diskPct: j.disk?.pct ?? null,
    hostname: j.hostname,
  };
}

/** Pesan error yang mudah dipahami untuk kegagalan jaringan umum. */
export function agentErrorMessage(e: unknown) {
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return 'Agen tidak merespons (timeout)';
  const code = err?.cause?.code;
  if (code === 'ECONNREFUSED') return 'Agen tidak berjalan atau port tertutup';
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Server agen tidak terjangkau';
  if (code === 'ENOTFOUND') return 'Alamat agen tidak ditemukan';
  return err?.message || String(e);
}
