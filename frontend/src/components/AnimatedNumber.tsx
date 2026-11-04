import { useEffect, useRef, useState } from 'react';

const reduceMotion =
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Angka yang bergulir halus ke nilai baru (bukan melompat). */
export function AnimatedNumber({ value, duration = 700 }: { value: number | null | undefined; duration?: number }) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const from = useRef<number | null>(value ?? null);
  const raf = useRef(0);

  useEffect(() => {
    cancelAnimationFrame(raf.current);
    if (value == null) {
      from.current = null;
      setShown(null);
      return;
    }
    const start = from.current;
    if (start == null || reduceMotion || start === value) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = start + (value - start) * easeOutCubic(t);
      from.current = v;
      setShown(v);
      if (t < 1) raf.current = requestAnimationFrame(step);
      else from.current = value;
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);

  if (shown == null) return <>—</>;
  const decimals = value != null && !Number.isInteger(value) ? 1 : 0;
  return <>{shown.toLocaleString('id-ID', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}
