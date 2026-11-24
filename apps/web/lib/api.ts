let csrf = "";
export const setCsrf = (c: string) => { csrf = c; };

export interface Me { id: string; email: string; name: string; globalRole: string; eventRoles: Record<string, string> }

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET", credentials: "same-origin",
    headers: { "content-type": "application/json", ...(csrf ? { "x-rsp-csrf": csrf } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
  return data as T;
}

export async function loadMe(): Promise<Me | null> {
  try {
    const r = await api<{ user: Me; csrf: string }>("/api/v1/auth/me");
    setCsrf(r.csrf);
    return r.user;
  } catch { return null; }
}
