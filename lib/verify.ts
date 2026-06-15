import type { Prospect, VerificationResult } from './types';
import { openai, CHAT_MODEL } from './openai';

// The boolean string a sourcer would type: name + company + role, quoted.
export function booleanQuery(p: Partial<Prospect>): string {
  const name = `"${[p.firstName, p.lastName].filter(Boolean).join(' ')}"`;
  const company = p.companyName ? `"${p.companyName}"` : '';
  const role = p.title ? `("${p.title}")` : '';
  return [name, company, role].filter(Boolean).join(' ').trim();
}

interface SerpResult {
  title: string;
  snippet: string;
  link: string;
}

// ---------------------------------------------------------------------------
// SERP provider. Default wiring is SerpAPI (set SERPAPI_KEY). Swap freely for
// Bing Web Search, Google Programmable Search (CSE), Serper.dev, etc.
// This scans a SEARCH ENGINE's index -- never LinkedIn directly. The public
// LinkedIn title text shows up in those snippets legally via the engine.
// ---------------------------------------------------------------------------
async function serpSearch(q: string): Promise<SerpResult[]> {
  const key = process.env.SERPAPI_KEY;
  if (!key) return [];
  const u = new URL('https://serpapi.com/search.json');
  u.searchParams.set('engine', 'google');
  u.searchParams.set('q', q);
  u.searchParams.set('num', '6'); // "first page" worth of results
  u.searchParams.set('api_key', key);
  const r = await fetch(u);
  if (!r.ok) return [];
  const j: any = await r.json();
  return (j.organic_results || []).slice(0, 6).map((o: any) => ({
    title: o.title || '',
    snippet: o.snippet || '',
    link: o.link || '',
  }));
}

// Optional: corporate-email deliverability as a weak "still there" signal.
// Wire your provider (ZeroBounce / NeverBounce / Hunter) and return true/false.
async function emailDeliverable(email?: string): Promise<boolean | null> {
  const key = process.env.EMAIL_VERIFY_KEY;
  if (!key || !email) return null;
  return null; // implement against your chosen provider
}

export async function verifyEmployment(p: Partial<Prospect>): Promise<VerificationResult> {
  const query = booleanQuery(p);
  const [serp, deliverable] = await Promise.all([serpSearch(query), emailDeliverable(p.email)]);

  if (!serp.length) {
    return {
      status: 'unknown',
      confidence: 0.2,
      evidence: ['No SERP provider configured (set SERPAPI_KEY) or no results.'],
      emailDeliverable: deliverable,
      query,
    };
  }

  const ctx = serp.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\n${s.link}`).join('\n\n');
  const sys =
    'You verify whether a person still works at a stated company using web-search snippets. ' +
    'Be conservative: only say they left if a result clearly shows a DIFFERENT current employer. ' +
    'A matching email domain and current-looking results are weak evidence they remain. Return ONLY valid JSON.';
  const user =
    `PERSON: ${p.firstName} ${p.lastName}\n` +
    `STATED COMPANY: ${p.companyName}\n` +
    `STATED TITLE: ${p.title}\n` +
    `EMAIL DOMAIN: ${(p.email || '').split('@')[1] || ''}\n\n` +
    `SEARCH RESULTS:\n${ctx}\n\n` +
    `Return JSON: {"status":"still_there|likely_left|unknown","confidence":0-1,` +
    `"currentCompany":"","currentTitle":"","evidence":["result # and reason"]}`;

  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  let j: any = {};
  try {
    j = JSON.parse(res.choices[0].message.content || '{}');
  } catch {
    /* keep defaults */
  }

  return {
    status: j.status === 'likely_left' || j.status === 'still_there' ? j.status : 'unknown',
    confidence: typeof j.confidence === 'number' ? j.confidence : 0.3,
    currentCompany: j.currentCompany || undefined,
    currentTitle: j.currentTitle || undefined,
    evidence: Array.isArray(j.evidence) ? j.evidence : [],
    emailDeliverable: deliverable,
    query,
  };
}
