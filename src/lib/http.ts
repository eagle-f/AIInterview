export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export const retryable = (error: unknown) => error instanceof HttpError
  ? [408, 429, 500, 502, 503, 504].includes(error.status)
  : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");

export const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Callers must use a stable request ID for retryable mutations. */
export async function requestJson<T>(url: string, init: RequestInit = {}, options: {
  attempts?: number; timeoutMs?: number; onRetry?: (attempt: number) => void;
  fetchImpl?: typeof fetch; wait?: typeof delay;
} = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
      const response = await (options.fetchImpl ?? fetch)(url, {
        ...init, signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { message?: string } | null;
        throw new HttpError(response.status, detail?.message ?? `请求失败 (${response.status})`);
      }
      return response.status === 204 ? undefined as T : await response.json() as T;
    } catch (error) {
      if (attempt === attempts - 1 || !retryable(error)) throw error;
      options.onRetry?.(attempt + 1);
      await (options.wait ?? delay)(1000 * 2 ** attempt);
    }
  }
  throw new Error("请求未完成");
}
