export type ApiErrorPayload = {
  error?: unknown;
  code?: string;
  connectUrl?: string;
  [key: string]: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload, fallbackMessage: string) {
    super(typeof payload.error === "string" ? payload.error : fallbackMessage);
    this.name = "ApiError";
    this.status = status;
    this.code = payload.code;
    this.payload = payload;
  }
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as ApiErrorPayload;
    throw new ApiError(res.status, payload, res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
