// lib/batch-runner.ts
// Client-side driver: slices rows into batches and POSTs them to /api/match (or
// /api/enrich) with bounded concurrency + per-batch retry. Results stream into
// `results` as each batch returns — same UX you have now, but it CAN'T 504, a
// failed batch costs one batch (not the run), and re-running resumes where it
// left off (rows already done are skipped, results deduped by email).

"use client";

import { useCallback, useRef, useState } from "react";

export interface RunnerOptions<Row = any> {
  /** "/api/match" (default) or "/api/enrich" */
  endpoint?: string;
  /** rows per request. 150 on Hobby; 250 on Vercel Pro w/ maxDuration=300 */
  batchSize?: number;
  /** batches in flight at once */
  concurrency?: number;
  /** per-batch retries on 429/5xx before the batch is marked failed */
  retries?: number;
  /** stable id used for dedupe/resume. Defaults to row.email */
  keyOf?: (row: Row) => string;
}

export interface RunnerState<Result = any> {
  results: Result[];
  processed: number; // rows with a result so far
  total: number; // rows in the current run
  running: boolean;
  failed: number; // rows in batches that permanently failed
  error: string | null; // last batch error message, if any
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postBatch(
  endpoint: string,
  prospects: any[],
  retries: number,
  signal: AbortSignal
): Promise<any[]> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prospects }),
        signal,
      });

      // Transient -> retry
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      // Other 4xx -> fatal, don't retry
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw Object.assign(new Error(text || `HTTP ${res.status}`), {
          status: res.status,
          fatal: true,
        });
      }

      const data = await res.json();
      return Array.isArray(data?.results) ? data.results : [];
    } catch (err: any) {
      if (signal.aborted) throw err;
      if (err?.fatal || attempt >= retries) throw err;
      const backoff = Math.min(20_000, 500 * 2 ** attempt) + Math.random() * 400;
      attempt++;
      await sleep(backoff);
    }
  }
}

export function useBatchRunner<Row = any, Result = any>(options: RunnerOptions<Row> = {}) {
  const {
    endpoint = "/api/match",
    batchSize = 150,
    concurrency = 4,
    retries = 5,
    keyOf = (r: any) => r.email,
  } = options;

  const [state, setState] = useState<RunnerState<Result>>({
    results: [],
    processed: 0,
    total: 0,
    running: false,
    failed: 0,
    error: null,
  });

  // Map of key -> result. Persists across runs so re-running resumes & dedupes.
  const resultMap = useRef<Map<string, Result>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

  const flush = useCallback(() => {
    setState((s) => ({
      ...s,
      results: Array.from(resultMap.current.values()),
      processed: resultMap.current.size,
    }));
  }, []);

  const run = useCallback(
    async (rows: Row[]) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      // Resume: skip rows already completed in a previous run.
      const done = resultMap.current;
      const todo = rows.filter((r) => !done.has(keyOf(r)));

      const batches: Row[][] = [];
      for (let i = 0; i < todo.length; i += batchSize) {
        batches.push(todo.slice(i, i + batchSize));
      }

      setState((s) => ({
        ...s,
        running: true,
        error: null,
        total: rows.length,
        processed: done.size,
        failed: 0,
      }));

      let cursor = 0;
      let failed = 0;

      const worker = async () => {
        while (cursor < batches.length && !ac.signal.aborted) {
          const batch = batches[cursor++];
          try {
            const out = await postBatch(endpoint, batch, retries, ac.signal);
            for (const r of out) resultMap.current.set(keyOf(r as any), r as Result);
            flush();
          } catch (err: any) {
            if (ac.signal.aborted) return;
            // Permanent batch failure: count its rows, keep processing the rest.
            failed += batch.length;
            setState((s) => ({ ...s, failed, error: err?.message ?? "batch failed" }));
          }
        }
      };

      await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
      setState((s) => ({ ...s, running: false }));
    },
    [endpoint, batchSize, concurrency, retries, keyOf, flush]
  );

  /** Stop the current run. Completed results are kept (call run() again to resume). */
  const abort = useCallback(() => {
    abortRef.current?.abort();
    setState((s) => ({ ...s, running: false }));
  }, []);

  /** Clear everything and start fresh. */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    resultMap.current = new Map();
    setState({ results: [], processed: 0, total: 0, running: false, failed: 0, error: null });
  }, []);

  return { ...state, run, abort, reset };
}
