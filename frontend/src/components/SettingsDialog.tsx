import { useEffect, useState, type FormEvent } from 'react';
import { apiFetch, postJson } from '../api';

interface Me {
  remember: boolean;
  rememberDays: number;
  passwordChangeable: boolean;
  access?: { ip: string; via: 'cloudflare' | 'direct'; https: boolean; lan: boolean };
}

/** Pengaturan akun: ganti password & info sesi login. */
export function SettingsDialog({ onClose, onLogout }: { onClose: () => void; onLogout: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [msg2, setMsg2] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    apiFetch('/api/me')
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .catch(() => {});
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (next.length < 8) return setMsg({ ok: false, text: 'Password baru minimal 8 karakter' });
    if (next !== again) return setMsg({ ok: false, text: 'Ulangi password baru: belum sama' });
    setBusy(true);
    try {
      const res = await postJson('/api/password', { current: cur, next });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Gagal mengganti password');
      setCur('');
      setNext('');
      setAgain('');
      setMsg({ ok: true, text: 'Password berhasil diganti. Perangkat lain yang masih login otomatis keluar.' });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const input =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10';
  const strength = next.length === 0 ? null : next.length < 8 ? 'Terlalu pendek' : /[A-Za-z]/.test(next) && /\d/.test(next) && next.length >= 10 ? 'Kuat' : 'Cukup';

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-end bg-black/40 backdrop-blur-sm sm:items-center sm:justify-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="sheet-in safe-b max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl">
        <h2 className="text-lg font-semibold text-slate-900">Pengaturan</h2>

        <section className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5 text-[13px] leading-relaxed text-slate-600 ring-1 ring-slate-200/70">
          {me?.remember ? (
            <>
              ✓ Perangkat ini <b className="text-slate-800">diingat</b>: tidak perlu login lagi selama dashboard dibuka minimal sekali
              dalam {me.rememberDays ?? 30} hari.
            </>
          ) : (
            <>Sesi login ini berakhir dalam beberapa jam. Centang <b className="text-slate-800">Ingat saya</b> saat login agar tidak perlu memasukkan password lagi.</>
          )}
        </section>

        {me?.access && (
          <p className="mt-2 px-1 text-[12px] text-slate-500">
            Akses saat ini:{' '}
            <b className="text-slate-700">
              {me.access.via === 'cloudflare' ? 'dari internet lewat Cloudflare Tunnel' : me.access.lan ? 'jaringan kantor / VPN' : 'langsung dari internet'}
            </b>{' '}
            · IP {me.access.ip} · {me.access.https ? '🔒 HTTPS' : 'HTTP'}
          </p>
        )}

        <form onSubmit={submit} className="mt-4">
          <h3 className="text-sm font-semibold text-slate-800">Ganti password</h3>
          {me && !me.passwordChangeable ? (
            <p className="mt-2 text-[13px] text-slate-500">
              Password diatur lewat <code>DBMON_ADMIN_PASSWORD</code> (file .env / environment). Ubah di sana lalu jalankan ulang server.
            </p>
          ) : (
            <>
              <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
              <div className="mt-2 space-y-2">
                <input className={input} type={show ? 'text' : 'password'} placeholder="Password lama" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
                <input className={input} type={show ? 'text' : 'password'} placeholder="Password baru (min. 8 karakter)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
                <input className={input} type={show ? 'text' : 'password'} placeholder="Ulangi password baru" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" required />
              </div>
              <div className="mt-2 flex items-center justify-between text-[12px] text-slate-500">
                <label className="flex items-center gap-1.5">
                  <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="h-3.5 w-3.5 accent-sky-600" />
                  Tampilkan
                </label>
                {strength && <span className={strength === 'Terlalu pendek' ? 'text-rose-600' : strength === 'Kuat' ? 'text-emerald-700' : ''}>Kekuatan: {strength}</span>}
              </div>
              {msg && <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</p>}
              <button disabled={busy} className="mt-3 w-full rounded-xl bg-sky-600 py-2.5 text-sm font-semibold text-onaccent shadow-sm transition hover:bg-sky-700 disabled:opacity-50">
                {busy ? 'Menyimpan…' : 'Simpan password baru'}
              </button>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                Lupa password: di komputer server hapus <code>backend\data\admin-password.hash</code>, lalu jalankan ulang server. Password
                baru dibuat & tercetak di jendela server (juga di <code>admin-password.txt</code>).
              </p>
            </>
          )}
        </form>

        <section className="mt-5 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-800">Perangkat yang sedang login</h3>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
            HP atau laptop hilang, atau pernah login di komputer orang lain? Keluarkan semua perangkat sekaligus; perangkat ini tetap masuk.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!confirm('Keluarkan semua perangkat lain yang sedang login?')) return;
              setBusy(true);
              const r = await postJson('/api/logout-all', {}).catch(() => null);
              setBusy(false);
              setMsg2(r?.ok ? { ok: true, text: 'Semua perangkat lain sudah dikeluarkan.' } : { ok: false, text: 'Gagal, coba lagi.' });
            }}
            className="mt-2 rounded-xl px-3 py-2 text-sm font-medium text-slate-700 ring-1 ring-slate-200 transition hover:bg-slate-50 disabled:opacity-50"
          >
            Keluarkan semua perangkat lain
          </button>
          {msg2 && <p className={`mt-2 rounded-lg px-3 py-2 text-sm ${msg2.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg2.text}</p>}
        </section>

        <div className="mt-5 flex gap-2 border-t border-slate-100 pt-4">
          <button onClick={onLogout} className="rounded-xl px-4 py-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50">
            Keluar dari perangkat ini
          </button>
          <span className="flex-1" />
          <button onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100">
            Tutup
          </button>
        </div>
      </div>
    </div>
  );
}
