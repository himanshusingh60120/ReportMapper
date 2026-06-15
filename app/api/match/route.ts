import { NextRequest, NextResponse } from 'next/server';
import { bestReportFor } from '@/lib/match';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { prospects } = await req.json();
    const list: Record<string, any>[] = Array.isArray(prospects) ? prospects : [prospects];
    const results = await Promise.all(
      list.map(async (p) => {
        try {
          return { prospect: p, best: await bestReportFor(p) };
        } catch (e: any) {
          return { prospect: p, best: null, error: e.message };
        }
      })
    );
    return NextResponse.json({ results });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
