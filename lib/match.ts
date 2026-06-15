import fs from 'node:fs';
import path from 'node:path';
import type { ReportItem, ReportMatch, Prospect } from './types';
import { embed, cosine, openai, CHAT_MODEL } from './openai';

let CATALOG: ReportItem[] | null = null;

// Loads the pre-built, pre-embedded catalog from disk (run scripts/build-catalog.mjs first).
export function loadCatalog(): ReportItem[] {
  if (CATALOG) return CATALOG;
  const p = path.join(process.cwd(), 'data', 'catalog.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      'data/catalog.json missing. Run: node scripts/build-catalog.mjs (needs OPENAI_API_KEY)'
    );
  }
  CATALOG = JSON.parse(fs.readFileSync(p, 'utf8')) as ReportItem[];
  return CATALOG;
}

// Turns a prospect row into the text we embed / hand to GPT.
export function prospectQuery(p: Partial<Prospect>): string {
  return [
    p.industry && `Industry: ${p.industry}`,
    p.subIndustry && `Sub-industry: ${p.subIndustry}`,
    p.companyName && `Company: ${p.companyName}`,
    p.title && `Role: ${p.title}`,
    p.department && `Department: ${p.department}`,
    p.level && `Seniority: ${p.level}`,
    p.country && `Region: ${p.country}`,
  ]
    .filter(Boolean)
    .join('. ');
}

// Stage 1: cheap vector similarity over the whole catalog -> top K candidates.
export async function shortlist(
  p: Partial<Prospect>,
  k = 25
): Promise<{ report: ReportItem; similarity: number }[]> {
  const cat = loadCatalog();
  const [qv] = await embed([prospectQuery(p)]);
  return cat
    .map((r) => ({ report: r, similarity: cosine(qv, r.embedding as number[]) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

// Stage 2: GPT re-ranks the shortlist with business reasoning + a one-line why.
export async function rerank(
  p: Partial<Prospect>,
  cands: { report: ReportItem; similarity: number }[],
  topN = 3
): Promise<ReportMatch[]> {
  const list = cands.map((c, i) => `${i + 1}. ${c.report.title}`).join('\n');
  const sys =
    'You match a B2B prospect to the market-research reports most worth pitching to them. ' +
    "Weigh the buyer's industry and sub-industry, what the company actually does, and whether " +
    "this person's function would realistically budget for the report's topic. Be strict: drop " +
    'anything off-topic even if it appears in the candidate list. Return ONLY valid JSON.';
  const user =
    `PROSPECT:\n${prospectQuery(p)}\n\n` +
    `CANDIDATE REPORTS:\n${list}\n\n` +
    `Return JSON: {"matches":[{"n":<candidate number>,"score":<0-100 fit>,"rationale":"<=18 words"}]}. ` +
    `Choose the best ${topN}, ordered by fit to THIS buyer's role and company.`;

  const res = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  let parsed: any = { matches: [] };
  try {
    parsed = JSON.parse(res.choices[0].message.content || '{"matches":[]}');
  } catch {
    /* fall through to empty */
  }

  return (parsed.matches || [])
    .map((m: any): ReportMatch | null => {
      const c = cands[(m.n || 0) - 1];
      if (!c) return null;
      return {
        report: { id: c.report.id, title: c.report.title, url: c.report.url },
        score: typeof m.score === 'number' ? m.score : Math.round(c.similarity * 100),
        similarity: c.similarity,
        rationale: m.rationale || '',
      };
    })
    .filter(Boolean)
    .sort((a: ReportMatch, b: ReportMatch) => b.score - a.score) as ReportMatch[];
}

export async function matchProspect(p: Partial<Prospect>, topN = 3): Promise<ReportMatch[]> {
  const cands = await shortlist(p, 25);
  if (!cands.length) return [];
  return rerank(p, cands, topN);
}
