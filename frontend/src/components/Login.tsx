import { useState, type FormEvent } from 'react';
import { postJson } from '../api';

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await postJson('/api/login', { password, remember });
      if (res.ok) return onSuccess();
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? 'Login gagal');
    } catch {
      setError('Server tidak dapat dihubungi');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="safe-x grid min-h-dvh place-items-center">
      <form onSubmit={submit} className="w-full max-w-sm card-in rounded-3xl border border-slate-200/80 bg-white p-6 shadow-[0_12px_32px_-16px_rgba(15,23,42,0.25)]">
        <h1 className="text-xl font-semibold text-slate-900">Dashboard Monitoring System</h1>
        <p className="mt-1 text-sm text-slate-500">Masukkan password admin.</p>
        {/* Nama pengguna tersembunyi: agar browser menawarkan "Simpan password" */}
        <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mt-5 w-full rounded-xl border border-slate-200 bg-white px-3 py-3 text-base text-slate-900 outline-none transition focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10"
          required
        />
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="h-4 w-4 accent-sky-600" />
          Ingat saya di perangkat ini (tidak perlu login lagi selama 30 hari)
        </label>
        {error && <p className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        <button
          disabled={busy}
          className="mt-4 w-full rounded-xl bg-sky-600 py-3 font-semibold text-onaccent shadow-sm transition hover:bg-sky-700 disabled:opacity-50"
        >
          {busy ? 'Masuk…' : 'Masuk'}
        </button>
        <p className="mt-4 text-xs leading-relaxed text-slate-500">
          Lupa password? Lihat file <code>admin-password.txt</code> di folder <code>backend\data</code> server. Bila password
          sudah diganti lewat aplikasi, hapus file <code>admin-password.hash</code> di folder itu lalu jalankan ulang server:
          password baru dibuat dan tercetak di jendela server.
        </p>
      </form>
    </div>
  );
}
