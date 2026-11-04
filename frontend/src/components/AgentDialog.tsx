import { useState, type FormEvent } from 'react';
import type { Connection } from '../types';
import { apiFetch } from '../api';

interface Props {
  conn: Connection;
  onClose: () => void;
  onSaved: (patch: Partial<Connection>) => void;
}

/** Pasang / ganti / lepas Monitoring Agent (CPU & RAM asli server database). */
export function AgentDialog({ conn, onClose, onSaved }: Props) {
  const [url, setUrl] = useState(conn.agentUrl ?? (conn.host ? `http://${conn.host}:9187` : ''));
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (agentUrl: string, agentToken: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await apiFetch(`/api/connections/${conn.id}/agent`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentUrl, agentToken }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? 'Gagal menyimpan');
      onSaved({ hasAgent: body.hasAgent, agentUrl: body.agentUrl });
      if (body.hasAgent) {
        setMsg({ ok: true, text: `Terhubung ke ${body.hostname} · CPU ${body.cpuPct ?? '—'}% · RAM ${body.memPct ?? '—'}%` });
        setTimeout(onClose, 1200);
      } else onClose();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(url, token);
  };

  const input =
    'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-sky-500 focus:ring-4 focus:ring-sky-500/10';

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-end bg-black/40 backdrop-blur-sm sm:items-center sm:justify-center" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="sheet-in safe-b w-full rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-md sm:rounded-3xl"
      >
        <h2 className="text-lg font-semibold text-slate-900">Agen CPU & RAM</h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          Untuk <b className="text-slate-700">{conn.name}</b>. Di server database jalankan <code className="text-slate-700">agent\menu-agent.bat</code>{' '}
          (pilih <i>Pasang jalan otomatis</i>), lalu salin Agent URL & Token yang tampil di menu tersebut.
        </p>
        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Agent URL</span>
            <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.10.20:9187"
              autoCapitalize="off" spellCheck={false} required />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-600">Token</span>
            <input className={input} value={token} onChange={(e) => setToken(e.target.value)}
              placeholder={conn.hasAgent ? 'Kosongkan untuk memakai token lama' : 'Token dari jendela agen'}
              autoCapitalize="off" autoComplete="off" spellCheck={false} required={!conn.hasAgent} />
          </label>
        </div>
        {msg && (
          <p className={`mt-3 rounded-lg px-3 py-2 text-sm ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</p>
        )}
        <div className="mt-5 flex gap-2">
          {conn.hasAgent && (
            <button type="button" disabled={busy} onClick={() => void save('', '')}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50">
              Lepas agen
            </button>
          )}
          <span className="flex-1" />
          <button type="button" onClick={onClose} className="rounded-xl px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-100">
            Batal
          </button>
          <button disabled={busy} className="rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-semibold text-onaccent shadow-sm transition hover:bg-sky-700 disabled:opacity-50">
            {busy ? 'Menguji…' : 'Tes & simpan'}
          </button>
        </div>
      </form>
    </div>
  );
}
