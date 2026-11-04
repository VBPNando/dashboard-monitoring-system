import { useState, type FormEvent, type ReactNode } from 'react';
import { ENGINE_META, type Connection, type Engine } from '../types';
import { postJson } from '../api';

interface Props {
  onCreated: (c: Connection) => void;
  onClose: () => void;
  /** Jenis awal yang dipilih (mengikuti tab yang sedang dibuka) */
  initial?: Engine;
}

const GROUPS: { label: string; items: Engine[] }[] = [
  { label: 'Database', items: ['mariadb', 'postgres', 'mssql', 'sqlite'] },
  { label: 'Server & Storage', items: ['proxmox', 'pbs', 'synology', 'abb'] },
  { label: 'Jaringan', items: ['fortigate', 'mikrotik', 'isp'] },
];

/** Petunjuk singkat per jenis: akun/izin yang dibutuhkan */
const HELP: Partial<Record<Engine, ReactNode>> = {
  proxmox: (
    <>
      Buat API token di Proxmox: <b>Datacenter → Permissions → API Tokens → Add</b> (hapus centang <i>Privilege Separation</i>), lalu beri
      role <b>PVEAuditor</b> pada path <code>/</code> untuk user token itu. Token ID berbentuk <code>user@pve!nama</code>.
    </>
  ),
  pbs: (
    <>
      Di PBS: <b>Configuration → Access Control → API Token → Add</b> (user mis. <code>monitor@pbs</code>), salin secret-nya. Lalu{' '}
      <b>Permissions → Add → API Token Permission</b>: path <code>/</code>, token tersebut, role <b>Audit</b> (hanya baca). Token ID
      berbentuk <code>user@pbs!nama</code>. Port bawaan 8007.
    </>
  ),
  synology: (
    <>
      Gunakan akun khusus monitoring anggota grup <b>administrators</b> <u>tanpa</u> verifikasi 2 langkah (2FA). Port bawaan DSM: 5001
      (https) atau 5000 (http).
    </>
  ),
  abb: (
    <>
      Memakai akun NAS yang menjalankan Active Backup for Business (grup <b>administrators</b>, tanpa 2FA). Bila NAS yang sama sudah
      ditambahkan, cukup isi akun yang sama — login dipakai bersama.
    </>
  ),
  fortigate: (
    <>
      Buat <b>System → Administrators → Create New → REST API Admin</b> dengan profil admin <b>read-only</b>, isi <b>Trusted Hosts</b> dengan IP
      komputer Dashboard, lalu salin API key yang muncul. Latency/loss per ISP diambil dari <b>SD-WAN Performance SLA</b> (bila
      dipakai). Port = port HTTPS admin FortiGate (bawaan 443).
    </>
  ),
  mikrotik: (
    <>
      Butuh <b>RouterOS v7.1+</b> (REST API). Aktifkan <b>IP → Services → www</b> (http, port 80) atau <b>www-ssl</b> (https, 443), batasi
      <i>Available From</i> ke IP komputer Dashboard, dan buat user grup <b>read</b>. Status ISP diambil dari default route &amp;
      <b> Tools → Netwatch</b>.
    </>
  ),
  isp: (
    <>
      Isi IP yang mewakili link ISP ini: gateway/modem ISP atau IP publik link tsb. IP harus bisa di-<i>ping</i> dari komputer
      Dashboard. Satu link = satu entri; gangguan dihitung bila ≥ 3 ping gagal berturut-turut.
    </>
  ),
};

/**
 * Form tambah sumber pemantauan. Di HP tampil sebagai bottom sheet penuh, di layar lebar sebagai modal.
 * Input HP: text-base (16px) mencegah iOS zoom otomatis; inputMode numeric untuk angka.
 */
export function ConnectionForm({ onCreated, onClose, initial = 'mariadb' }: Props) {
  const [engine, setEngine] = useState<Engine>(initial);
  const [form, setForm] = useState({
    name: '',
    host: '',
    port: String(ENGINE_META[initial].port ?? ''),
    username: '',
    password: '',
    database: '',
    filePath: '',
    https: true,
    node: '',
    provider: '',
    slaTarget: '99.5',
    intervalSec: '10',
    method: 'ping' as 'ping' | 'tcp',
    tcpPort: '443',
    latencyWarnMs: '100',
    staleHours: '26',
    vdom: '',
  });
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const changeEngine = (e: Engine) => {
    setEngine(e);
    setMsg(null);
    setForm((f) => ({ ...f, port: String(ENGINE_META[e].port ?? ''), https: e !== 'mikrotik' }));
  };

  const payload = () => {
    const name = form.name.trim() || (engine === 'isp' ? form.provider || form.host : form.host);
    switch (engine) {
      case 'sqlite':
        return { engine, name: form.name || form.filePath, filePath: form.filePath };
      case 'proxmox':
        return {
          engine,
          name,
          host: form.host,
          port: Number(form.port) || 8006,
          username: form.username,
          password: form.password,
          options: { https: form.https, node: form.node || undefined },
        };
      case 'pbs':
        return {
          engine,
          name,
          host: form.host,
          port: Number(form.port) || 8007,
          username: form.username,
          password: form.password,
          options: { https: form.https, staleHours: Number(form.staleHours) || 26 },
        };
      case 'synology':
      case 'abb':
        return {
          engine,
          name,
          host: form.host,
          port: Number(form.port) || undefined,
          username: form.username,
          password: form.password,
          options: { https: form.https, ...(engine === 'abb' ? { staleHours: Number(form.staleHours) || 26 } : {}) },
        };
      case 'fortigate':
        return {
          engine,
          name,
          host: form.host,
          port: Number(form.port) || undefined,
          password: form.password,
          options: { https: form.https, vdom: form.vdom || undefined },
        };
      case 'mikrotik':
        return {
          engine,
          name,
          host: form.host,
          port: Number(form.port) || undefined,
          username: form.username,
          password: form.password,
          options: { https: form.https },
        };
      case 'isp':
        return {
          engine,
          name,
          host: form.host,
          options: {
            provider: form.provider || undefined,
            slaTarget: Number(form.slaTarget.replace(',', '.')) || 99.5,
            intervalSec: Number(form.intervalSec) || 10,
            method: form.method,
            tcpPort: form.method === 'tcp' ? Number(form.tcpPort) || 443 : undefined,
            latencyWarnMs: Number(form.latencyWarnMs) || 100,
          },
        };
      default:
        return {
          engine,
          name: form.name || `${form.host}:${form.port}`,
          host: form.host,
          port: Number(form.port),
          username: form.username,
          password: form.password,
          database: form.database || undefined,
        };
    }
  };

  async function send(path: string, kind: 'test' | 'save') {
    setBusy(kind);
    setMsg(null);
    try {
      const res = await postJson(path, payload());
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Input tidak valid');
      return body;
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      return null;
    } finally {
      setBusy(null);
    }
  }

  const test = async () => {
    const r = await send('/api/connections/test', 'test');
    if (r) setMsg({ ok: true, text: `${r.message ?? 'Koneksi berhasil'} ✓` });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const created = await send('/api/connections', 'save');
    if (created) onCreated(created);
  };

  const input =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10';
  const label = 'mb-1 block text-xs font-medium text-slate-500';
  const isDb = ['mariadb', 'postgres', 'mssql'].includes(engine);
  const needsLogin = isDb || engine === 'proxmox' || engine === 'synology' || engine === 'abb' || engine === 'mikrotik' || engine === 'pbs';

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-end bg-black/40 backdrop-blur-sm sm:items-center sm:justify-center" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="sheet-in safe-b max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-lg sm:rounded-3xl"
      >
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-slate-200 sm:hidden" />
        <h2 className="text-lg font-semibold text-slate-900">Tambah pemantauan</h2>

        {/* Pilihan jenis: tombol besar, mudah di-tap */}
        {GROUPS.map((g) => (
          <div key={g.label} className="mt-3">
            <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">{g.label}</p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {g.items.map((e) => (
                <button
                  type="button"
                  key={e}
                  onClick={() => changeEngine(e)}
                  className={`rounded-xl border px-2 py-2.5 text-[13px] font-medium transition ${
                    engine === e ? 'border-sky-500 bg-sky-50 text-sky-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {ENGINE_META[e].label}
                </button>
              ))}
            </div>
          </div>
        ))}

        {HELP[engine] && <p className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 ring-1 ring-slate-200/70">{HELP[engine]}</p>}

        <div className="mt-4 space-y-3">
          <input
            className={input}
            placeholder={engine === 'isp' ? 'Nama link (mis. Link Utama Kantor)' : 'Nama (opsional)'}
            value={form.name}
            onChange={set('name')}
          />

          {engine === 'sqlite' ? (
            <input className={input} placeholder="Nama file (mis. app.db) atau path lengkap di server" value={form.filePath} onChange={set('filePath')} autoCapitalize="off" required />
          ) : engine === 'isp' ? (
            <>
              <div className="grid grid-cols-2 gap-2">
                <input className={input} placeholder="Provider (mis. Telkom)" value={form.provider} onChange={set('provider')} />
                <input className={input} placeholder="IP yang di-ping" value={form.host} onChange={set('host')} autoCapitalize="off" spellCheck={false} required />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <label>
                  <span className={label}>Target SLA (%)</span>
                  <input className={input} value={form.slaTarget} onChange={set('slaTarget')} inputMode="decimal" required />
                </label>
                <label>
                  <span className={label}>Ping tiap (detik)</span>
                  <input className={input} value={form.intervalSec} onChange={set('intervalSec')} inputMode="numeric" required />
                </label>
                <label>
                  <span className={label}>Batas latency (ms)</span>
                  <input className={input} value={form.latencyWarnMs} onChange={set('latencyWarnMs')} inputMode="numeric" />
                </label>
              </div>
              <div className="grid grid-cols-[1fr_7rem] gap-2">
                <label>
                  <span className={label}>Metode</span>
                  <select className={input} value={form.method} onChange={set('method')}>
                    <option value="ping">Ping (ICMP)</option>
                    <option value="tcp">Cek port TCP (bila ping diblokir)</option>
                  </select>
                </label>
                {form.method === 'tcp' && (
                  <label>
                    <span className={label}>Port</span>
                    <input className={input} value={form.tcpPort} onChange={set('tcpPort')} inputMode="numeric" />
                  </label>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="grid grid-cols-[1fr_6.5rem] gap-2">
                <input className={input} placeholder="IP / Host" value={form.host} onChange={set('host')} autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
                <input className={input} placeholder="Port" value={form.port} onChange={set('port')} inputMode="numeric" pattern="[0-9]*" required={isDb} />
              </div>
              {needsLogin && (
                <>
                  <input
                    className={input}
                    placeholder={engine === 'proxmox' ? 'Token ID (mis. monitor@pve!dbmon)' : engine === 'pbs' ? 'Token ID (mis. monitor@pbs!dashboard)' : 'Username'}
                    value={form.username}
                    onChange={set('username')}
                    autoCapitalize="off"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                  <input
                    className={input}
                    type="password"
                    placeholder={engine === 'proxmox' || engine === 'pbs' ? 'Secret token' : 'Password'}
                    value={form.password}
                    onChange={set('password')}
                    autoComplete="new-password"
                    required={!isDb}
                  />
                </>
              )}
              {engine === 'fortigate' && (
                <>
                  <input className={input} type="password" placeholder="API key (REST API Admin)" value={form.password} onChange={set('password')} autoComplete="new-password" spellCheck={false} required />
                  <input className={input} placeholder="VDOM (opsional, kosong = root)" value={form.vdom} onChange={set('vdom')} autoCapitalize="off" />
                </>
              )}
              {isDb && <input className={input} placeholder="Database (opsional)" value={form.database} onChange={set('database')} autoCapitalize="off" />}
              {engine === 'proxmox' && <input className={input} placeholder="Node tertentu (opsional, kosong = semua node)" value={form.node} onChange={set('node')} autoCapitalize="off" />}
              {(engine === 'abb' || engine === 'pbs') && (
                <label className="block">
                  <span className={label}>Alert bila tidak ada backup sukses lebih dari (jam)</span>
                  <input className={input} value={form.staleHours} onChange={set('staleHours')} inputMode="numeric" />
                </label>
              )}
              {!isDb && (
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={form.https} onChange={(e) => {
                      const on = e.target.checked;
                      // MikroTik: www (80) ↔ www-ssl (443)
                      setForm((f) => ({ ...f, https: on, port: engine === 'mikrotik' && (f.port === '80' || f.port === '443' || !f.port) ? (on ? '443' : '80') : f.port }));
                    }} className="h-4 w-4 accent-sky-600" />
                  Pakai HTTPS (sertifikat self-signed diterima){engine === 'mikrotik' ? ' · www-ssl, port 443' : ''}
                </label>
              )}
            </>
          )}
        </div>

        {msg && <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</p>}

        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={test} disabled={!!busy} className="rounded-xl border border-slate-200 py-3 font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50">
            {busy === 'test' ? 'Menguji…' : 'Tes koneksi'}
          </button>
          <button type="submit" disabled={!!busy} className="rounded-xl bg-sky-600 py-3 font-semibold text-onaccent shadow-sm transition hover:bg-sky-700 disabled:opacity-50">
            {busy === 'save' ? 'Menyimpan…' : 'Simpan'}
          </button>
        </div>
      </form>
    </div>
  );
}
