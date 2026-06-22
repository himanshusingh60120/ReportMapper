// lib/match.ts
// Full matching pipeline:
//   embed query (shared 512-d embedder) -> cosine shortlist -> GPT re-rank,
//   PLUS company + person profiling so every UI column fills, PLUS an optional
//   paid web-research / employment-verify pass gated behind the UI toggle.
//
// Per prospect (toggle OFF — needs only OPENAI_API_KEY):
//   1) profileCompany()  -> company_profile + sector   (inferred from name/domain, no fetch)
//   2) profilePerson()   -> person_profile             (inferred from title/dept/seniority)
//   3) shortlist + rerank -> best report + confidence + reasoning
//   person_function stays your sheet "designation" verbatim (unchanged on purpose).
//
// Per prospect (toggle ON — "Deep web research (paid)"):
//   + profileCompany() reads the real company website
//   + researchPersonWeb() (OpenAI search model) feeds a real bio into the profile
//   + verifyEmployment() (SerpAPI boolean check) flags likely job changes
//   These only run when webResearch === true, and each degrades to "" / null if a
//   key is missing or a call fails — they never break a row.

import { openai, embed, cosine, CHAT_MODEL } from "./openai";
import { pLimit, retry } from "./concurrency";
import { profileCompany } from "./profile";
import { profilePerson, researchPersonWeb, type PersonProfile } from "./person";
import { verifyEmployment } from "./verify";
import catalogJson from "../data/catalog.json";
import type { Prospect } from "./types";

// Re-export so app/api routes can keep importing Prospect from here.
export type { Prospect };

// ---- config (override via env) ---------------------------------------------
const SHORTLIST_K = Number(process.env.SHORTLIST_K ?? 25);
const RERANK_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY ?? 8);

// ---- types -----------------------------------------------------------------
export interface MatchOptions {
  /** When true, run the paid web-research + employment-verify pass. */
  webResearch?: boolean;
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
  reasoning: string; // why this report fits
  industry: string; // buyer industry (badge)
  industryReason: string; // optional "why" sub-line
  personFunction: string; // buyer role (badge) — kept as the sheet designation
  personProfile: string; // what this contact most likely does day-to-day
  companyProfile: string; // shown under "Company (researched)"
  sector: string; // short sector label
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

// Lightweight intermediate from the re-ranker before person/company context is attached.
interface RerankPick {
  report: { title: string; url: string };
  confidence: number;
  reasoning: string;
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

async function rerank(
  p: Prospect,
  candidates: CatalogItem[],
  person: PersonProfile
): Promise<RerankPick[]> {
  if (candidates.length === 0) return [];
  const list = candidates.map((c, i) => `${i}. ${c.title}`).join("\n");
  const system =
    "You are a B2B market-research matching engine. Given a buyer and a numbered " +
    "list of candidate report titles, pick the 3 that best fit the buyer's company, " +
    "industry, and role. Respond with JSON only.";
  const user =
    `Buyer:\n` +
    `- Company: ${p.companyName ?? "?"}\n` +
    `- Industry: ${p.industry ?? "?"} / ${p.subIndustry ?? "?"}\n` +
    `- Role: ${p.title ?? "?"} (level: ${p.level ?? "?"}, dept: ${p.department ?? "?"})\n` +
    (person.function ? `- Business function: ${person.function}\n` : "") +
    (person.interests ? `- Likely research interests: ${person.interests}\n` : "") +
    (person.summary ? `- About this contact: ${person.summary}\n` : "") +
    `\nCandidate reports:\n${list}\n\n` +
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

  return picks
    .filter((pk) => candidates[pk.index])
    .slice(0, 3)
    .map((pk) => {
      const c = candidates[pk.index];
      return {
        report: { title: c.title, url: c.url },
        confidence: clamp(pk.confidence ?? pk.score),
        reasoning: String(pk.reason ?? ""),
      };
    });
}

// ---- public API -------------------------------------------------------------

/** Match a single prospect. Pass a precomputed query vector to skip re-embedding. */
export async function matchOne(
  p: Prospect,
  queryVec?: number[],
  opts: MatchOptions = {}
): Promise<MatchResult> {
  const webResearch = opts.webResearch === true;
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

    // (1) Company profile. Reads the real site only when deep research is on;
    //     otherwise infers from the name/domain (no fetch, no per-query fee).
    const company = await profileCompany(
      p.companyName ?? "",
      webResearch ? p.companyWebsite ?? "" : ""
    );

    // (2) Optional paid web research + employment verification (only when toggled).
    let extra = "";
    let verifiedNote = "";
    if (webResearch) {
      const [bio, verification] = await Promise.all([
        researchPersonWeb(p).catch(() => ""),
        verifyEmployment(p).catch(() => null),
      ]);
      if (bio) extra += `Web research on this person: ${bio}\n`;
      if (verification?.status === "likely_left" && verification.currentCompany) {
        verifiedNote = `Heads up: may have moved to ${verification.currentCompany}.`;
        extra +=
          `Employment check: likely left ${p.companyName ?? ""}; ` +
          `current employer may be ${verification.currentCompany}.\n`;
      }
    }

    // (3) Person profile (cheap GPT inference; sharper when `extra` carries a real bio).
    const person = await profilePerson(
      p,
      { summary: company.summary, sector: company.sector },
      extra
    );

    // (4) Shortlist by embedding similarity, then GPT re-rank for the best report.
    const candidates = shortlist(vec, SHORTLIST_K);
    const picks = await rerank(p, candidates, person);

    // Attach the shared person/company context to every pick.
    const matches: ReportMatch[] = picks.map((pk) => ({
      report: pk.report,
      confidence: pk.confidence,
      reasoning: pk.reasoning,
      industry: p.industry ?? "",
      industryReason: "",
      personFunction: p.title ?? "", // keep the sheet designation, per request
      personProfile: [person.summary, verifiedNote].filter(Boolean).join(" "),
      companyProfile: company.summary || (p.companyName ?? ""),
      sector: company.sector ?? "",
    }));

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
 *   2) Profile + re-rank concurrently, capped at RERANK_CONCURRENCY.
 * An empty catalog or a dimension mismatch throws here (clear 500) rather than
 * degrading every row to a silent "No strong match".
 */
export async function matchBatch(
  prospects: Prospect[],
  opts: MatchOptions = {}
): Promise<MatchResult[]> {
  if (prospects.length === 0) return [];
  const queries = prospects.map(toQuery);
  const vectors = await embed(queries);
  assertCatalogReady(vectors[0]?.length ?? 0);
  const limit = pLimit(RERANK_CONCURRENCY);
  return Promise.all(prospects.map((p, i) => limit(() => matchOne(p, vectors[i], opts))));
}

// Back-compat: some older imports referenced embedMany from this module.
export const embedMany = embed;
