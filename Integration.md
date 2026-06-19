# Fixing FUNCTION_INVOCATION_TIMEOUT — integration guide

The 504 happened because the whole job (33,659 rows × embedding + GPT call each)
ran inside **one** Vercel function invocation, which is capped at minutes. At your
observed ~10 rows/sec that job needs ~56 minutes of continuous compute — no plan
gives you that in a single request. The fix: process the work in small batches and
loop from the client. Your matching logic is unchanged.

## Files in this bundle

| File | New? | What it does |
|---|---|---|
| `lib/concurrency.ts` | new | `pLimit()` semaphore + `retry()` backoff. Zero deps. Safe drop-in. |
| `lib/batch-runner.ts` | new | `useBatchRunner()` React hook — the actual fix. Chunks rows, runs N batches concurrently, retries failed batches, resumes, accumulates results live. |
| `app/api/match/route.ts` | replace | Now processes ONE batch and returns. Adds `maxDuration` + a batch-size guard. |
| `app/api/enrich/route.ts` | replace | Same batch pattern; smaller batches + lower concurrency (SERP rate limits). |
| `lib/match.ts` | **diff, don't overwrite** | Reference build of your documented algorithm. The parts you actually need are `embedMany()` (batched embeddings) and `matchBatch()` (the `pLimit` fan-out). Port those two into your real file. |

## Verify these 3 assumptions (I rebuilt `lib/match.ts` from your README, not your source)

1. **Catalog shape** — I assume `data/catalog.json` items are
   `{ title, url, embedding }`. If your keys differ, fix `CatalogItem` + `shortlist()`.
2. **OpenAI client** — I assume `lib/openai.ts` exports `openai` (the SDK instance).
   Fix the import if it default-exports or uses another name.
3. **Verify export** — `app/api/enrich/route.ts` assumes
   `verifyEmployment(p) => { status, currentCompany? }` from `lib/verify.ts`.
   Adjust the call in `enrichOne()` to your real signature.

Also: map `MatchResult` fields (`company`, `industry`, `role`, `best`, `confidence`,
`matches`) to whatever your results table and CSV/Excel export currently read.

## Wire the hook into `app/page.tsx`

Replace your single "fetch everything once" call with the hook. Keep your existing
parsing, table, and download code — just point them at `results`.

```tsx
"use client";
import { useBatchRunner } from "../lib/batch-runner";

// inside your component:
const {
  run, abort, reset,
  results, processed, total, running, failed, error,
} = useBatchRunner({
  endpoint: deepResearch ? "/api/enrich" : "/api/match", // your "Deep web research" checkbox
  batchSize: 150,   // 250 if on Vercel Pro (see below)
  concurrency: 4,   // 4 batches in flight ≈ 600 rows processing at once
});

// "Find best report" button:
<button onClick={() => run(parsedRows)} disabled={running}>
  {running ? "Matching…" : "Find best report"}
</button>
<button onClick={abort} disabled={!running}>Pause</button>
<button onClick={reset}>Clear</button>

// progress line (replaces "Processed X of Y"):
<p>Processed {processed} of {total}{failed ? ` · ${failed} failed` : ""}{error ? ` — ${error}` : ""}</p>

// render `results` in your existing table; each item is a MatchResult.
// Your "Download CSV / Excel / Save to live file" buttons read from `results` too.
```

`parsedRows` is just your pasted sheet turned into objects (one per row, with at
least an `email` field for dedupe/resume).

## Plan-specific knobs

- **Vercel Hobby** (≈60s function cap): keep `maxDuration = 60`, `MAX_BATCH = 150`
  in the route, and `batchSize: 150` in the hook.
- **Vercel Pro** (configurable, up to ~300s, ~800s with Fluid Compute): set
  `export const maxDuration = 300` in both routes, raise `MAX_BATCH` to ~250, and
  `batchSize: 250`. Fewer, bigger requests = less overhead.

(Double-check current Vercel caps in your dashboard — they change over time. The
batch size just has to keep a single batch comfortably under whatever your cap is.)

## What to expect after this

- No more 504. Each request finishes in seconds.
- 33k rows ≈ 15–25 min wall-clock at `concurrency: 4` — a progress bar, not one
  click-and-wait. It survives any single batch failure and resumes on re-run.
- Tradeoff: it depends on the browser tab staying open. If you need unattended
  bulk runs, move the loop to a queue (Upstash QStash / Inngest / Trigger.dev)
  writing results to a DB, or use OpenAI's **Batch API** (async, 50% cheaper) for
  a "bulk mode" with no live table.

## Two speedups already included in `matchBatch`

- **Batched embeddings** — `embedMany()` embeds a whole batch in a few requests
  instead of one request per prospect. Biggest latency/cost win.
- **Bounded concurrency + 429 backoff** — re-ranks fan out `RERANK_CONCURRENCY`
  at a time with retries, so you push throughput without tripping rate limits.
  Tune via env: `RERANK_CONCURRENCY`, `SHORTLIST_K`, `EMBED_CHUNK`, `CHAT_MODEL`.
  If you sustain ~10 rows/sec for an hour, confirm your OpenAI usage tier has the
  RPM/TPM headroom (or switch heavy bulk runs to the Batch API).
