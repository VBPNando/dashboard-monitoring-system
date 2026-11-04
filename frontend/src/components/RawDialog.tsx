import { useEffect, useState } from 'react';
import type { Connection } from '../types';
import { apiFetch } from '../api';

/**
 * Data mentah terakhir dari perangkat — untuk diagnosa bila angka tidak sesuai
 * (terutama Active Backup for Business yang API-nya tidak didokumentasikan Synology).
 */
export function RawDialog({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const [text, setText] = useState('Memuat…');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    apiFetch(`/api/connections/${conn.id}/raw`)
      .then((r) => r.json())
      .then((b: { raw?: unknown; error?: string }) => setText(b.error ?? (b.raw == null ? 'Belum ada data (tunggu pengecekan berikutnya).' : JSON.stringify(b.raw, null, 2).slice(0, 300_000))))
      .catch(() => setText('Gagal memuat'));
  }, [conn.id]);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="fade-in fixed inset-0 z-50 flex items-end bg-black/40 backdrop-blur-sm sm:items-center sm:justify-center" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="sheet-in safe-b flex max-h-[88dvh] w-full flex-col rounded-t-3xl bg-white p-5 shadow-2xl sm:max-w-3xl sm:rounded-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Data mentah · {conn.name}</h2>
            <p className="mt-0.5 text-sm text-slate-500">Respons API terakhir. Salin & kirimkan bila ada angka yang tidak sesuai.</p>
          </div>
          <button onClick={onClose} className="grid h-8 w-8 place-items-center rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Tutup">
            ✕
          </button>
        </div>
        <pre className="thin-scroll mt-3 min-h-0 flex-1 overflow-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 ring-1 ring-slate-200/70">{text}</pre>
        <div className="mt-3 flex justify-end">
          <button onClick={copy} className="rounded-xl bg-sky-600 px-4 py-2 text-sm font-semibold text-onaccent shadow-sm transition hover:bg-sky-700">
            {copied ? 'Tersalin ✓' : 'Salin'}
          </button>
        </div>
      </div>
    </div>
  );
}
