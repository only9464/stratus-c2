/**
 * 极薄的 API 客户端：fetch + Bearer + 统一错误。
 * 注意：任务/结果内容是**密文**，本层只做搬运，不做任何解密。
 */

const TOKEN_KEY = 'stc2.token';

export interface ApiError {
  code: string;
  message: string;
  request_id?: string;
  details?: unknown;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

class ApiClient {
  private token: string | null = localStorage.getItem(TOKEN_KEY);
  private probed: boolean | null = null;

  hasToken(): boolean {
    return Boolean(this.token);
  }

  setToken(token: string | null): void {
    this.token = token;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  /** 探索：没 token 时也能判断是否处于 Access 模式（/me 返回 200 即已认证）。 */
  async probe(): Promise<boolean> {
    if (this.probed !== null) return this.probed;
    try {
      const res = await fetch('/api/v1/me', { headers: this.headers() });
      this.probed = res.ok;
      return this.probed;
    } catch {
      this.probed = false;
      return false;
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'x-requested-with': 'stc2', ...(extra ?? {}) };
    if (this.token) h['authorization'] = `Bearer ${this.token}`;
    return h;
  }

  async get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(path, location.origin);
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) throw new HttpError(res.status, await safeJson(res));
    return (await res.json()) as T;
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new HttpError(res.status, await safeJson(res));
    return (await res.json()) as T;
  }

  async del<T>(path: string): Promise<T> {
    const res = await fetch(path, { method: 'DELETE', headers: this.headers() });
    if (!res.ok) throw new HttpError(res.status, await safeJson(res));
    return (await res.json()) as T;
  }

  async raw(path: string, init?: RequestInit): Promise<Response> {
    return fetch(path, { ...init, headers: this.headers(init?.headers as Record<string, string>) });
  }
}

async function safeJson(res: Response): Promise<ApiError> {
  try {
    const j = (await res.json()) as { error?: ApiError };
    return j.error ?? { code: 'E_UNKNOWN', message: `HTTP ${res.status}` };
  } catch {
    return { code: 'E_UNKNOWN', message: `HTTP ${res.status}` };
  }
}

export const api = new ApiClient();
