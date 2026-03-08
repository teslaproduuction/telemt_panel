const TELEMT_BASE = '/api/telemt';
const AUTH_BASE = '/api/auth';

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(base: string, path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (res.status === 401 && base === TELEMT_BASE) {
    window.location.href = '/login';
    throw new ApiError('unauthorized', 'Session expired');
  }

  const json = await res.json();
  if (!json.ok) {
    throw new ApiError(json.error?.code || 'unknown', json.error?.message || 'Unknown error');
  }

  return json.data;
}

export const telemt = {
  get: <T>(path: string) => request<T>(TELEMT_BASE, path),
  post: <T>(path: string, body: unknown) =>
    request<T>(TELEMT_BASE, path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(TELEMT_BASE, path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) =>
    request<T>(TELEMT_BASE, path, { method: 'DELETE' }),
};

const PANEL_BASE = '/api';

export const panelApi = {
  get: <T>(path: string) => request<T>(PANEL_BASE, path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(PANEL_BASE, path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
};

export const authApi = {
  login: (username: string, password: string) =>
    request<{ username: string }>(AUTH_BASE, '/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () =>
    request<null>(AUTH_BASE, '/logout', { method: 'POST' }),
  me: () =>
    request<{ username: string }>(AUTH_BASE, '/me'),
};
