// lib/match.ts
// Prospect -> report matcher: embed query (SHARED embedder) -> cosine shortlist
// -> GPT re-rank. Returns `best` in the EXACT shape app/page.tsx reads.
//
// What changed vs. the broken version:
//   1) Query embeddings now use embed() from ./openai, which requests the SAME
//      `dimensions` (EMBED_DIMS, default 512) that scripts/build-catalog.mjs used.
//      The old local embedMany() omitted `dimensions`, so it produced 1536-d
//      query vectors that could never be compared to the 512-d catalog
//      (cosine -> NaN -> garbage shortlist).
//   2) The result `best` is reshaped to match what the UI + CSV export read:
//      { report:{title,url}, confidence, reasoning, industry, personFunction,
//        companyProfile, ... } instead of the flat { title,url,score,reason }.
//   3) Loud guards: an empty catalog or a dimension mismatch now THROW a clear
//      error (surfaced by the route as a 500) instead of silently returning
//      "No strong match" for every row.

import { openai, embed, cosine, CHAT_MODEL } from "./openai";
import { pLimit, retry } from "./concurrency";
import catalogJson from "../data/catalog.json";

// ---- config (override via env) ---------------------------------------------
const SHORTLIST_K = Number(process.env.SHORTLIST_K ?? 25);
const RERANK_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY ?? 8);

// ---- types -----------------------------------------------------------------
export interface Prospect {
  firstName?: string;
  lastName?: string;
  title?: string;
  companyName?: string;
  companyWebsite?: string;
  department?: string;
  level?: string;
  industry?: string;
  subIndustry?: string;
  country?: string;
  email: string;
  linkedin?: string;
  [key: string]: unknown; // tolerate extra CSV columns
}

// Shape written by scripts/build-catalog.mjs.
export interface CatalogItem {
  id?: string;
  slug?: string;
  title: string;
  url: string;
  industry?: string;
  embedding: number[];
}

// Shaped to match EXACTLY what app/page.tsx (table + CSV export) reads off `best`.
export interface ReportMatch {
  report: { title: string; url: string };
  confidence: number; // 0-100 from the re-ranker
  reasoning: string; // one line: why this report fits
  industry?: string; // buyer industry (rendered as a badge)
  industryReason?: string; // optional "why" sub-line
  personFunction?: string; // buyer role (rendered as a badge)
  personProfile?: string; // optional "why" sub-line
  companyProfile?: string; // shown under "Company (researched)"
  sector?: string; // optional sub-line
}

export interface MatchResult {
  email: string;
  prospect: Prospect;
  company: string;
  industry: string; // top-level: kept so the 12-domain Excel split still works
  role: string;
  matches: ReportMatch[]; // top 3
  best: ReportMatch | null; // matches[0]
  confidence: number; // best?.confidence ?? 0
  error?: string;
}

const catalog = catalogJson as unknown as CatalogItem[];

// ---- helpers ----------------------------------------------------------------
function toQuery(p: Prospect): string {
  return [p.industry, p.subIndustry, p.companyName, p.title, p.department, p.level]
    .filter(Boolean)
    .join(" · ");
}

function clamp(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

// Fail loud and explain, instead of silently returning "No strong match".
function assertCatalogReady(queryDims: number): void {
  if (!catalog.length) {
    throw new Error(
      "Report catalog is empty. Run `npm run build:catalog` (needs OPENAI_API_KEY) and redeploy."
    );
  }
  const catDims = catalog[0]?.embedding?.length ?? 0;
  if (catDims !== queryDims) {
    throw new Error(
      `Embedding dimension mismatch: query is ${queryDims}-d but catalog is ${catDims}-d. ` +
        "Set EMBED_DIMS identically for the app and scripts/build-catalog.mjs, then rebuild the catalog."
    );
  }
}

function shortlist(queryVec: number[], k: number): CatalogItem[] {
  return catalog
    .map((item) => ({ item, score: cosine(queryVec, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.item);
}

async function rerank(p: Prospect, candidates: CatalogItem[]): Promise<ReportMatch[]> {
  const list = candidates.map((c, i) => `${i}. ${c.title}`).join("\n");
  const system =
    "You are a B2B market-research matching engine. Given a buyer and a numbered " +
    "list of candidate report titles, pick the 3 that best fit the buyer's company, " +
    "industry, and role. Respond with JSON only.";
  const user =
    `Buyer:\n` +
    `- Company: ${p.companyName ?? "?"}\n` +
    `- Industry: ${p.industry ?? "?"} / ${p.subIndustry ?? "?"}\n` +
    `- Role: ${p.title ?? "?"} (level: ${p.level ?? "?"}, dept: ${p.department ?? "?"})\n\n` +
    `Candidate reports:\n${list}\n\n` +
    `Return JSON shaped exactly as:\n` +
    `{"picks":[{"index":<number from the list>,"confidence":<0-100>,"reason":"<=14 words"}]}\n` +
    `Pick the 3 best, ordered most to least relevant.`;

  const res = await retry(() =>
    openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    })
  );

  const raw = res.choices[0]?.message?.content ?? "{}";
  let picks: Array<{ index: number; confidence?: number; score?: number; reason: string }> = [];
  try {
    picks = JSON.parse(raw)?.picks ?? [];
  } catch {
    picks = [];
  }

  // Report fields come from the matched catalog item; buyer-context fields
  // (industry, role, company) come straight from the prospect row. The deeper
  // "researched" fields (sector, companyProfile description, personProfile,
  // industryReason) are left for the /api/enrich path — the UI renders missing
  // ones gracefully, so the table stays clean.
  return picks
    .filter((pk) => candidates[pk.index])
    .slice(0, 3)
    .map((pk) => {
      const c = candidates[pk.index];
      return {
        report: { title: c.title, url: c.url },
        confidence: clamp(pk.confidence ?? pk.score),
        reasoning: String(pk.reason ?? ""),
        industry: p.industry || c.industry || "",
        personFunction: p.title || "",
        companyProfile: p.companyName || "", // basic value until enrichment is wired
      } as ReportMatch;
    });
}

// ---- public API -------------------------------------------------------------

/** Match a single prospect. Pass a precomputed query vector to skip re-embedding. */
export async function matchOne(p: Prospect, queryVec?: number[]): Promise<MatchResult> {
  const base = {
    email: p.email,
    prospect: p,
    company: p.companyName ?? "",
    industry: [p.industry, p.subIndustry].filter(Boolean).join(" / "),
    role: p.title ?? "",
  };
  try {
    const vec = queryVec ?? (await embed([toQuery(p)]))[0];
    assertCatalogReady(vec?.length ?? 0);
    const candidates = shortlist(vec, SHORTLIST_K);
    const matches = await rerank(p, candidates);
    return {
      ...base,
      matches,
      best: matches[0] ?? null,
      confidence: matches[0]?.confidence ?? 0,
    };
  } catch (err: any) {
    return {
      ...base,
      matches: [],
      best: null,
      confidence: 0,
      error: err?.message ?? "match failed",
    };
  }
}

/**
 * Match a BATCH. This is what the API route calls.
 *   1) Embed every query together (few requests, correct dimensions).
 *   2) Re-rank concurrently, capped at RERANK_CONCURRENCY, with per-call retries.
 * An empty catalog or a dimension mismatch throws here (clear 500) rather than
 * degrading every row to a silent "No strong match".
 */
export async function matchBatch(prospects: Prospect[]): Promise<MatchResult[]> {
  if (prospects.length === 0) return [];
  const queries = prospects.map(toQuery);
  const vectors = await embed(queries);
  assertCatalogReady(vectors[0]?.length ?? 0);
  const limit = pLimit(RERANK_CONCURRENCY);
  return Promise.all(prospects.map((p, i) => limit(() => matchOne(p, vectors[i]))));
}

// Back-compat: some older imports referenced embedMany from this module.
export const embedMany = embed;
