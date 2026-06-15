import { NextRequest, NextResponse } from 'next/server';
import { matchProspect } from '@/lib/match';
import type { Prospect } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { prospects, topN = 3 } = await req.json();
    const list: Partial<Prospect>[] = Array.isArray(prospects) ? prospects : [prospects];
    const results = [];
    for (const p of list) {
      try {
        results.push({ prospect: p, matches: await matchProspect(p, topN) });
      } catch (e: any) {
        results.push({ prospect: p, matches: [], error: e.message });
      }
    }
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
