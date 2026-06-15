import { NextRequest, NextResponse } from 'next/server';
import { verifyEmployment } from '@/lib/verify';
import { matchProspect } from '@/lib/match';
import type { Prospect, EnrichedProspect } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  try {
    const { prospects } = await req.json();
    const list: Partial<Prospect>[] = Array.isArray(prospects) ? prospects : [prospects];
    const out: EnrichedProspect[] = [];

    for (const p of list) {
      const verification = await verifyEmployment(p);

      let effective: Partial<Prospect> = { ...p };
      let previousCompanyMatches;

      if (verification.status === 'likely_left' && verification.currentCompany) {
        // Keep the old suggestion for reference, then re-match on the new employer.
        previousCompanyMatches = await matchProspect(p, 3);
        effective = {
          ...p,
          companyName: verification.currentCompany,
          title: verification.currentTitle || p.title,
          industry: '', // let the model re-infer from the new company
          subIndustry: '',
        };
      }

      const matches = await matchProspect(effective, 3);
      out.push({ ...(p as Prospect), verification, matches, previousCompanyMatches });
    }

    return NextResponse.json({ results: out });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
