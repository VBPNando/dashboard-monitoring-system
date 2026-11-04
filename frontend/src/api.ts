export const UNAUTHORIZED_EVENT = 'dbmon:unauthorized';

/** fetch dengan cookie sesi; jika sesi habis (401) aplikasi kembali ke layar login. */
export async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(path, { credentials: 'same-origin', ...init });
  if (res.status === 401 && path !== '/api/login') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  return res;
}

export function postJson(path: string, body: unknown) {
  return apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
