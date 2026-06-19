// app/api/enrich/route.ts
// Same batch-per-invocation pattern as /api/match, but each row does more work
// (SERP verify + GPT judgment + possible re-match), so batches are smaller and
// concurrency is lower (SERP providers rate-limit harder than OpenAI).
//
// INTEGRATION SEAM: this assumes lib/verify.ts exports
//     verifyEmployment(p: Prospect) => Promise<{ status: string; currentCompany?: string }>
// Adjust the call in enrichOne() to match whatever your verify.ts actually exports.

import { matchOne, type Prospect, type MatchResult } from "../../../lib/match";
import { pLimit } from "../../../lib/concurrency";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — adjust this import/signature to your real verify.ts
import { verifyEmployment } from "../../../lib/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hobby: 60. Pro: 300. Enrich is heavier per row — keep batches small either way.
export const maxDuration = 60;

const MAX_BATCH = 75;
const CONCURRENCY = 5;

type EnrichResult = MatchResult & {
  employment?: string;
  newCompany?: string;
  previousMatch?: MatchResult["best"];
};

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const prospects: Prospect[] = Array.isArray(body?.prospects) ? body.prospects : [];

    if (prospects.length === 0) {
      return Response.json({ error: "Send { prospects: Prospect[] }" }, { status: 400 });
    }
    if (prospects.length > MAX_BATCH) {
      return Response.json(
        { error: `Batch too large (${prospects.length}). Max ${MAX_BATCH} per request.` },
        { status: 413 }
      );
    }

    const limit = pLimit(CONCURRENCY);
    const results = await Promise.all(prospects.map((p) => limit(() => enrichOne(p))));
    return Response.json({ results });
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "enrich failed" }, { status: 500 });
  }
}

async function enrichOne(p: Prospect): Promise<EnrichResult> {
  const original = await matchOne(p);

  let employment = "unknown";
  let newCompany: string | undefined;
  try {
    const v = await verifyEmployment(p); // expected: { status, currentCompany? }
    employment = v?.status ?? "unknown";
    newCompany = v?.currentCompany;
  } catch {
    // Verification is best-effort; on failure keep the original match.
    return { ...original, employment };
  }

  // Clearly moved + we found a new employer -> re-match on the new company,
  // but keep the old suggestion for reference.
  const moved =
    (employment === "likely_left" || employment === "left") &&
    newCompany &&
    newCompany.trim() !== "" &&
    newCompany !== p.companyName;

  if (moved) {
    const rematched = await matchOne({ ...p, companyName: newCompany });
    return {
      ...rematched,
      prospect: p,
      employment,
      newCompany,
      previousMatch: original.best,
    };
  }

  return { ...original, employment, newCompany };
}
