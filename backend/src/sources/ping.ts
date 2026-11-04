import { spawn } from 'node:child_process';
import net from 'node:net';

export interface ProbeResult {
  ok: boolean;
  ms: number | null;
  error?: string;
}

const HOST_RE = /^[a-zA-Z0-9.:_-]{1,253}$/;

/**
 * Baca hasil perintah ping (Windows bahasa Inggris/Indonesia/lainnya, Linux, macOS).
 *   Windows : "Reply from 8.8.8.8: bytes=32 time=12ms TTL=117"
 *             "Balasan dari 8.8.8.8: byte=32 waktu=12ms TTL=117"
 *             "Reply from 8.8.8.8: bytes=32 time<1ms TTL=128"
 *   Linux   : "64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.3 ms"
 * Berhasil hanya bila ada TTL: Windows mengembalikan kode sukses juga untuk
 * "Destination host unreachable" yang dibalas router, padahal tujuan tidak terjangkau.
 */
export function parsePing(output: string): ProbeResult {
  const ok = /\bttl[=:]\s*\d+/i.test(output);
  if (!ok) {
    if (/unreachable|tidak dapat dijangkau|tidak terjangkau/i.test(output)) return { ok: false, ms: null, error: 'Tujuan tidak terjangkau' };
    if (/could not find host|unknown host|name or service not known|tidak dapat menemukan/i.test(output))
      return { ok: false, ms: null, error: 'Nama host tidak ditemukan' };
    return { ok: false, ms: null, error: 'Timeout' };
  }
  if (/<\s*1\s*ms/i.test(output)) return { ok: true, ms: 0.5 }; // "time<1ms"
  const m = /(?:time|waktu|zeit|temps|tiempo|tempo|czas|tijd)\s*[=<]\s*([\d.,]+)\s*ms/i.exec(output) ?? /[=<]\s*([\d.,]+)\s*ms/i.exec(output);
  return { ok: true, ms: m ? Number(m[1].replace(',', '.')) : null };
}

/** Satu ping ICMP memakai perintah ping sistem (tanpa hak administrator). */
export function pingOnce(host: string, timeoutMs = 1500): Promise<ProbeResult> {
  if (!HOST_RE.test(host)) return Promise.resolve({ ok: false, ms: null, error: 'Alamat tidak valid' });
  const win = process.platform === 'win32';
  const args = win
    ? ['-n', '1', '-w', String(timeoutMs), host]
    : process.platform === 'darwin'
      ? ['-c', '1', '-W', String(timeoutMs), host]
      : ['-c', '1', '-W', String(Math.max(1, Math.ceil(timeoutMs / 1000))), host];
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r: ProbeResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn('ping', args, { windowsHide: true });
    } catch {
      return finish({ ok: false, ms: null, error: 'Perintah ping tidak tersedia, gunakan metode TCP' });
    }
    p.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr?.on('data', (d: Buffer) => (out += d.toString()));
    p.on('error', (e: NodeJS.ErrnoException) =>
      finish({ ok: false, ms: null, error: e.code === 'ENOENT' ? 'Perintah ping tidak tersedia, gunakan metode TCP' : e.message }),
    );
    p.on('close', () => finish(parsePing(out)));
    setTimeout(() => {
      p.kill();
      finish({ ok: false, ms: null, error: 'Timeout' });
    }, timeoutMs + 2500).unref();
  });
}

/**
 * Cek TCP: waktu membuka koneksi ke host:port. Hanya koneksi yang benar-benar terbuka yang
 * dihitung "up". "Connection refused" dihitung gagal: penolakan bisa datang dari firewall/proxy
 * lokal sehingga tidak membuktikan link ISP hidup. Pilih port yang pasti terbuka (mis. 443 atau 53).
 */
export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10;
    const s = net.connect({ host, port });
    const done = (r: ProbeResult) => {
      s.destroy();
      resolve(r);
    };
    s.setTimeout(timeoutMs, () => done({ ok: false, ms: null, error: 'Timeout' }));
    s.once('connect', () => done({ ok: true, ms: ms() }));
    s.once('error', (e: NodeJS.ErrnoException) =>
      done({
        ok: false,
        ms: null,
        error: e.code === 'ECONNREFUSED' ? `Port ${port} ditolak (pilih port yang terbuka, mis. 443 atau 53)` : (e.code ?? e.message),
      }),
    );
  });
}
