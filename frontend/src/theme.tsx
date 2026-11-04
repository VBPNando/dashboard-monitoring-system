import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';

/**
 * Palet seri grafik per tema (palet kategorikal tervalidasi: lolos uji buta warna antar-seri
 * bersebelahan; versi gelap ≥ 3:1 terhadap latar kartu gelap). Urutan slot tetap.
 */
const PALETTE = {
  light: { s1: '#2a78d6', s2: '#eb6834', s3: '#1baf7a', s4: '#eda100' },
  dark: { s1: '#3987e5', s2: '#d95926', s3: '#199e70', s4: '#c98500' },
} as const;
export type SeriesKey = keyof (typeof PALETTE)['light'];

/** Warna kerangka grafik (sumbu, garis bantu, tooltip) per tema */
const CHROME = {
  light: { axis: '#64748b', grid: '#eef2f6', tipBg: 'rgba(255,255,255,0.97)', tipBorder: '#e2e8f0', tipText: '#0f172a', tipMuted: '#64748b', pointer: '#cbd5e1', ring: '#ffffff', outage: 'rgba(220,38,38,0.10)' },
  dark: { axis: '#8b98ad', grid: '#1c2740', tipBg: 'rgba(17,26,43,0.97)', tipBorder: '#2b3850', tipText: '#f3f6fa', tipMuted: '#9aa8bd', pointer: '#3a4a66', ring: '#111a2b', outage: 'rgba(240,98,122,0.16)' },
} as const;

interface Ctx {
  theme: Theme;
  toggle: () => void;
  palette: (typeof PALETTE)[Theme];
  chrome: (typeof CHROME)[Theme];
}

const ThemeCtx = createContext<Ctx>({ theme: 'light', toggle: () => {}, palette: PALETTE.light, chrome: CHROME.light });

const KEY = 'dbmon.theme';

function initial(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'dark' || t === 'light') return t;
  } catch {
    /* mode privat */
  }
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initial);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#070b14' : '#f5f7fa');
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* mode privat */
    }
  }, [theme]);
  return (
    <ThemeCtx.Provider
      value={{ theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), palette: PALETTE[theme], chrome: CHROME[theme] }}
    >
      {children}
    </ThemeCtx.Provider>
  );
}

export const useTheme = () => useContext(ThemeCtx);

/** Tombol ganti tema (☀ terang / ☾ gelap) */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      onClick={toggle}
      className="grid h-8 w-8 place-items-center rounded-xl text-slate-600 transition hover:bg-slate-100"
      title={dark ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
      aria-label={dark ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
    >
      <span className="text-[17px] leading-none transition-transform duration-500" style={{ transform: dark ? 'rotate(-30deg)' : 'none' }}>
        {dark ? '☾' : '☀'}
      </span>
    </button>
  );
}
