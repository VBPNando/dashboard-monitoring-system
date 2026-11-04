import { useEffect, useState } from 'react';

/** true bila lebar layar ≥ breakpoint (default 1024px = desktop/laptop). */
export function useMinWidth(px = 1024) {
  const query = `(min-width: ${px}px)`;
  const [match, setMatch] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatch(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return match;
}

/** Status & toggle mode layar penuh browser (menyembunyikan tab & address bar). */
export function useFullscreen() {
  const [active, setActive] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const onChange = () => setActive(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const supported = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => {});
  };
  return { active, supported, toggle };
}

/** Grid panel: 1 database penuh layar, 2 ke atas dua kolom. */
export function wallGrid(n: number) {
  const cols = n <= 1 ? 1 : 2;
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** Sampai 4 database muat satu layar tanpa scroll (2×2). */
export const WALL_FIT = 4;
