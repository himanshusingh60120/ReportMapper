// lib/concurrency.ts
// Small, dependency-free concurrency helpers. No npm install needed.

export type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Caps the number of concurrently-running async tasks.
 *
 *   const limit = pLimit(10);
 *   await Promise.all(items.map((it) => limit(() => work(it))));
 *
 * Use this to fan out OpenAI calls without firing thousands at once.
 */
export function pLimit(concurrency: number): Limiter {
  const max = Math.max(1, Math.floor(concurrency));
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active--;
    if (queue.length > 0) {
      active++;
      queue.shift()!();
    }
  };

  return function <T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        // Promise.resolve().then guards against fns that throw synchronously.
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(next);
      };
      if (active < max) {
        active++;
        run();
      } else {
        queue.push(run);
      }
    });
  };
}

/**
 * Retries a task on transient failures (HTTP 429 / 5xx / network) with
 * exponential backoff + jitter. Honors a Retry-After header hint when present.
 * Non-transient errors (4xx other than 429) are thrown immediately.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; maxMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 20_000;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const status: number | undefined = err?.status ?? err?.response?.status;
      const transient =
        status === 429 ||
        (typeof status === "number" && status >= 500 && status < 600) ||
        status === undefined; // network/abort-less errors

      if (!transient || attempt > retries) throw err;

      const retryAfterSec = Number(err?.response?.headers?.["retry-after"]);
      const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : 0;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const jitter = Math.random() * backoff * 0.25;
      const wait = retryAfterMs > 0 ? retryAfterMs : backoff + jitter;

      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
