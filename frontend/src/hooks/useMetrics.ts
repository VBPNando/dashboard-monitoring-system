import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  isDevice,
  type AlertSnapshot,
  type ConnStatus,
  type Details,
  type DevicePoint,
  type DeviceUpdate,
  type Engine,
  type HistoryPoint,
  type MetricPoint,
  type RangeKey,
} from '../types';
import { apiFetch, UNAUTHORIZED_EVENT } from '../api';

const LIVE_WINDOW = 300; // database: 5 menit @1 detik
const DEVICE_WINDOW = 360; // perangkat: ±30 menit (interval 5 dtk)

type StatusMap = Record<string, { status: ConnStatus; message?: string }>;
type Src = { id: string; engine: Engine };

/**
 * Satu koneksi WebSocket untuk seluruh dashboard (dibuat sekali).
 * Database: metrik per detik, detail (sesi/lock/slow query). Perangkat: data terbaru + deret waktu.
 * Semua: status koneksi & alert.
 */
export function useMetrics(sources: Src[]) {
  const [live, setLive] = useState<Record<string, MetricPoint[]>>({});
  const [devLive, setDevLive] = useState<Record<string, DevicePoint[]>>({});
  const [devData, setDevData] = useState<Record<string, DeviceUpdate>>({});
  const [status, setStatus] = useState<StatusMap>({});
  const [details, setDetails] = useState<Record<string, Details>>({});
  const [alerts, setAlerts] = useState<Record<string, AlertSnapshot>>({});
  const socketRef = useRef<Socket | null>(null);
  const idsRef = useRef<string[]>([]);
  idsRef.current = sources.map((s) => s.id);
  const key = idsRef.current.join(',');

  useEffect(() => {
    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;
    const markUp = (id: string) =>
      setStatus((prev) => (prev[id]?.status === 'up' ? prev : { ...prev, [id]: { status: 'up' } }));

    socket.on('metric', (p: MetricPoint) => {
      setLive((prev) => {
        const arr = prev[p.connId] ?? [];
        return { ...prev, [p.connId]: arr.length >= LIVE_WINDOW ? [...arr.slice(1), p] : [...arr, p] };
      });
      markUp(p.connId);
    });
    socket.on('device', (d: DeviceUpdate) => {
      setDevData((prev) => ({ ...prev, [d.connId]: d }));
      setDevLive((prev) => {
        const arr = prev[d.connId] ?? [];
        if (arr.at(-1)?.ts === d.ts) return prev;
        const p = { ts: d.ts, v: d.series };
        return { ...prev, [d.connId]: arr.length >= DEVICE_WINDOW ? [...arr.slice(1), p] : [...arr, p] };
      });
      markUp(d.connId);
    });
    socket.on('status', (s: { connId: string; status: ConnStatus; message?: string }) =>
      setStatus((prev) => ({ ...prev, [s.connId]: { status: s.status, message: s.message } })),
    );
    socket.on('details', (d: Details) => setDetails((prev) => ({ ...prev, [d.connId]: d })));
    socket.on('alerts', (a: AlertSnapshot) => setAlerts((prev) => ({ ...prev, [a.connId]: a })));
    // Saat HP kembali online / tab aktif lagi, socket.io reconnect otomatis → subscribe ulang
    socket.on('connect', () => socket.emit('subscribe', idsRef.current));
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    });
    return () => {
      socket.disconnect();
    };
  }, []);

  // Subscribe sumber baru + isi awal grafik dari riwayat di server
  useEffect(() => {
    const socket = socketRef.current;
    if (socket?.connected) socket.emit('subscribe', idsRef.current);
    for (const s of sources) {
      const dev = isDevice(s.engine);
      if (dev ? devLive[s.id]?.length : live[s.id]?.length) continue;
      apiFetch(`/api/connections/${s.id}/history?range=live`)
        .then((r) => (r.ok ? r.json() : { points: [] }))
        .then((res: { points: unknown[] }) => {
          if (dev) {
            const pts = res.points as DevicePoint[];
            setDevLive((prev) => (prev[s.id]?.length ? prev : { ...prev, [s.id]: pts.slice(-DEVICE_WINDOW) }));
          } else {
            const pts = res.points as MetricPoint[];
            setLive((prev) => (prev[s.id]?.length ? prev : { ...prev, [s.id]: pts.slice(-LIVE_WINDOW) }));
          }
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { live, devLive, devData, status, details, alerts };
}

/** Data ringkasan untuk rentang waktu ≥ 15 menit; diperbarui berkala. */
export function useRange(connIds: string[], range: RangeKey) {
  const [data, setData] = useState<Record<string, (HistoryPoint | DevicePoint)[]>>({});
  const key = connIds.join(',');

  useEffect(() => {
    if (range === 'live') return;
    let stop = false;
    const load = () =>
      Promise.all(
        connIds.map((id) =>
          apiFetch(`/api/connections/${id}/history?range=${range}`)
            .then((r) => (r.ok ? r.json() : { points: [] }))
            .then((res: { points: (HistoryPoint | DevicePoint)[] }) => [id, res.points] as const)
            .catch(() => [id, [] as HistoryPoint[]] as const),
        ),
      ).then((entries) => {
        if (!stop) setData(Object.fromEntries(entries));
      });
    setData({});
    void load();
    const t = setInterval(load, range === '15m' ? 10_000 : range === '7d' || range === '30d' ? 300_000 : 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, range]);

  return data;
}
