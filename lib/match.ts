// lib/match.ts
// Shortlist (embeddings) -> GPT re-rank, with the two scale fixes baked in:
//   1) embedMany(): embeds a whole batch in a handful of requests, not one per row
//   2) matchBatch(): re-ranks the batch with a bounded concurrency pool + retries
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE THINGS TO VERIFY AGAINST YOUR ACTUAL CODE (I rebuilt this from the README):
//   (a) CatalogItem shape — I assume data/catalog.json items look like
//         { title: string, url: string, embedding: number[] }
//       If your slugs/urls live under different keys, fix CatalogItem + shortlist().
//   (b) ./openai exports an `openai` client (the OpenAI SDK instance). If it
//       default-exports or names it differently, fix the import below.
//   (c) The MatchResult shape — map these fields to whatever your table/CSV reads.
// ─────────────────────────────────────────────────────────────────────────────

import { openai } from "./openai";
import { pLimit, retry } from "./concurrency";
import catalogJson from "../data/catalog.json";

// ---- config (override via env) ---------------------------------------------
const EMBED_MODEL = process.env.EMBED_MODEL ?? "text-embedding-3-small";
const CHAT_MODEL = process.env.CHAT_MODEL ?? "gpt-4o-mini";
const SHORTLIST_K = Number(process.env.SHORTLIST_K ?? 25);
const RERANK_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY ?? 8);
const EMBED_CHUNK = Number(process.env.EMBED_CHUNK ?? 256); // inputs per embeddings request

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

export interface CatalogItem {
  title: string;
  url: string;
  embedding: number[];
}

export interface ReportMatch {
  title: string;
  url: string;
  score: number; // 0–100 confidence from the re-ranker
  reason: string;
}

export interface MatchResult {
  email: string;
  prospect: Prospect;
  company: string;
  industry: string;
  role: string;
  matches: ReportMatch[]; // top 3
  best: ReportMatch | null; // matches[0]
  confidence: number; // best?.score ?? 0
  error?: string;
}

const catalog = catalogJson as unknown as CatalogItem[];

// ---- helpers ----------------------------------------------------------------
function toQuery(p: Prospect): string {
  return [p.industry, p.subIndustry, p.companyName, p.title, p.department, p.level]
    .filter(Boolean)
    .join(" · ");
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

function clamp(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function shortlist(queryVec: number[], k: number): CatalogItem[] {
  return catalog
    .map((item) => ({ item, score: cosine(queryVec, item.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.item);
}

/**
 * Embeds many texts in as few requests as possible. This is the single biggest
 * speedup vs. embedding one query per prospect. Output index aligns with input.
 */
export async function embedMany(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_CHUNK) {
    const slice = texts.slice(i, i + EMBED_CHUNK);
    const res = await retry(() =>
      openai.embeddings.create({ model: EMBED_MODEL, input: slice })
    );
    for (const d of res.data) out.push(d.embedding as number[]);
  }
  return out;
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
    `{"picks":[{"index":<number from the list>,"score":<0-100 confidence>,"reason":"<=12 words"}]}\n` +
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
  let picks: Array<{ index: number; score: number; reason: string }> = [];
  try {
    picks = JSON.parse(raw)?.picks ?? [];
  } catch {
    picks = [];
  }

  return picks
    .filter((pk) => candidates[pk.index])
    .slice(0, 3)
    .map((pk) => ({
      title: candidates[pk.index].title,
      url: candidates[pk.index].url,
      score: clamp(pk.score),
      reason: String(pk.reason ?? ""),
    }));
}

// ---- public API -------------------------------------------------------------

/** Match a single prospect. Pass a precomputed query vector to skip re-embedding. */
export async function matchOne(p: Prospect, queryVec?: number[]): Promise<MatchResult> {
  try {
    const vec = queryVec ?? (await embedMany([toQuery(p)]))[0];
    const candidates = shortlist(vec, SHORTLIST_K);
    const matches = await rerank(p, candidates);
    return {
      email: p.email,
      prospect: p,
      company: p.companyName ?? "",
      industry: [p.industry, p.subIndustry].filter(Boolean).join(" / "),
      role: p.title ?? "",
      matches,
      best: matches[0] ?? null,
      confidence: matches[0]?.score ?? 0,
    };
  } catch (err: any) {
    return {
      email: p.email,
      prospect: p,
      company: p.companyName ?? "",
      industry: [p.industry, p.subIndustry].filter(Boolean).join(" / "),
      role: p.title ?? "",
      matches: [],
      best: null,
      confidence: 0,
      error: err?.message ?? "match failed",
    };
  }
}

/**
 * Match a BATCH. This is what the API route calls.
 * 1) Embed every query together (few requests).
 * 2) Re-rank concurrently, capped at RERANK_CONCURRENCY, with per-call retries.
 * A single failed row degrades to a MatchResult with `.error` instead of
 * blowing up the whole batch.
 */
export async function matchBatch(prospects: Prospect[]): Promise<MatchResult[]> {
  if (prospects.length === 0) return [];
  const queries = prospects.map(toQuery);
  const vectors = await embedMany(queries);
  const limit = pLimit(RERANK_CONCURRENCY);
  return Promise.all(prospects.map((p, i) => limit(() => matchOne(p, vectors[i]))));
}
