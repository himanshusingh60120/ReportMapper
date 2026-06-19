// app/api/match/route.ts
// Processes ONE batch per invocation and returns. The client (see
// lib/batch-runner.ts) loops over batches, so a single request never runs long
// enough to hit FUNCTION_INVOCATION_TIMEOUT.

import { matchBatch, type Prospect } from "../../../lib/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Hobby plan: 60. Vercel Pro: bump to 300 (and raise MAX_BATCH below to ~250).
export const maxDuration = 60;

// Keep batches small enough that even a slow batch finishes well under maxDuration.
const MAX_BATCH = 150;

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

    const results = await matchBatch(prospects);
    return Response.json({ results });
  } catch (err: any) {
    return Response.json({ error: err?.message ?? "match failed" }, { status: 500 });
  }
}
