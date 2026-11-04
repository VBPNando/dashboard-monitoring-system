import http from 'node:http';
import https from 'node:https';

export interface HttpOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** Body form-urlencoded (Synology) */
  form?: Record<string, string>;
  /** Terima sertifikat self-signed (bawaan Proxmox & Synology). Default: true */
  insecure?: boolean;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * Permintaan HTTP(S) yang mengembalikan JSON.
 * Memakai modul bawaan Node (bukan fetch) agar bisa menerima sertifikat self-signed
 * per permintaan, tanpa mematikan verifikasi TLS untuk seluruh aplikasi.
 */
export function requestJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T> {
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  if (body) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = String(Buffer.byteLength(body));
  }
  return new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(
      u,
      {
        method: opts.method ?? (body ? 'POST' : 'GET'),
        headers,
        timeout: opts.timeoutMs ?? 8000,
        ...(isHttps ? { rejectUnauthorized: !(opts.insecure ?? true) } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 0;
          if (status === 401) return reject(new HttpError('Autentikasi ditolak (401): periksa user/token', status));
          if (status === 403) return reject(new HttpError('Akses ditolak (403): hak akses kurang', status));
          if (status >= 400) return reject(new HttpError(`HTTP ${status}: ${text.slice(0, 200)}`, status));
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new HttpError(`Respons bukan JSON (HTTP ${status})`, status));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new HttpError('Tidak merespons (timeout)')));
    req.on('error', (e: NodeJS.ErrnoException) => reject(new HttpError(netMessage(e))));
    if (body) req.write(body);
    req.end();
  });
}

export function netMessage(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case 'ECONNREFUSED':
      return 'Koneksi ditolak: layanan tidak berjalan atau port salah';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'Host tidak terjangkau dari komputer Dashboard Monitoring System';
    case 'ENOTFOUND':
      return 'Alamat host tidak ditemukan';
    case 'ETIMEDOUT':
      return 'Tidak merespons (timeout)';
    case 'ECONNRESET':
      return 'Koneksi diputus oleh server (cek http/https & port)';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'Sertifikat self-signed ditolak';
    default:
      return e.message;
  }
}
