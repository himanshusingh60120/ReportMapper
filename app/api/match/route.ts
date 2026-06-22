// app/api/match/route.ts
// Processes ONE batch per invocation and returns. The client (page.tsx) loops
// over batches, so a single request never runs long enough to hit
// FUNCTION_INVOCATION_TIMEOUT.

import { matchBatch, type Prospect } from "../../../lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hobby plan: 60. Vercel Pro: bump to 300 (and raise MAX_BATCH below to ~250).
export const maxDuration = 60;

// Keep batches small enough that even a slow batch finishes well under maxDuration.
// Deep web research is much heavier per row, so cap those batches lower.
const MAX_BATCH = 150;
const MAX_BATCH_WEB = 40;

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const prospects: Prospect[] = Array.isArray(body?.prospects) ? body.prospects : [];
    const webResearch = body?.webResearch === true;

    if (prospects.length === 0) {
      return Response.json({ error: "Send { prospects: Prospect[] }" }, { status: 400 });
    }

    const cap = webResearch ? MAX_BATCH_WEB : MAX_BATCH;
    if (prospects.length > cap) {
      return Response.json(
        {
          error: `Batch too large (${prospects.length}). Max ${cap} per request${
            webResearch ? " with deep web research on" : ""
          }.`,
        },
        { status: 413 }
      );
    }

    const results = await matchBatch(prospects, { webResearch });
    return Response.json({ results });
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "match failed" }, { status: 500 });
  }
}
