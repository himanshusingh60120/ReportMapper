import fs from 'node:fs';
import path from 'node:path';
import type { ReportItem, ReportMatch, Prospect } from './types';
import { embed, cosine, openai, CHAT_MODEL } from './openai';

let CATALOG: ReportItem[] | null = null;

export function loadCatalog(): ReportItem[] {
  if (CATALOG) return CATALOG;
  const p = path.join(process.cwd(), 'data', 'catalog.json');
  if (!fs.existsSync(p)) {
    throw new Error('data/catalog.json missing. Run scripts/build-catalog.mjs.');
  }
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) throw new Error('data/catalog.json is empty. Re-run scripts/build-catalog.mjs.');
  CATALOG = JSON.parse(raw) as ReportItem[];
  if (!CATALOG.length || !CATALOG[0].embedding) {
    throw new Error('data/catalog.json has no embedded reports. Re-run scripts/build-catalog.mjs.');
  }
  return CATALOG;
}

// Accept any header style (camelCase, snake_case, spaced) and map to our schema.
function pick(raw: Record<string, any>, ...aliases: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const keyMap = new Map(Object.keys(raw).map((k) => [norm(k), k]));
  for (const a of aliases) {
    const hit = keyMap.get(norm(a));
    if (hit && raw[hit] != null && String(raw[hit]).trim()) return String(raw[hit]).trim();
  }
  return '';
}

export function normalizeProspect(raw: Record<string, any>): Partial<Prospect> {
  return {
    firstName: pick(raw, 'firstName', 'first_name', 'fname'),
    lastName: pick(raw, 'lastName', 'last_name', 'lname'),
    title: pick(raw, 'title', 'jobTitle', 'job_title', 'position'),
    companyName: pick(raw, 'companyName', 'company_name', 'company', 'organization'),
    companyWebsite: pick(raw, 'companyWebsite', 'company_website', 'website', 'domain'),
    department: pick(raw, 'department'),
    level: pick(raw, 'level', 'seniority'),
    industry: pick(raw, 'industry'),
    subIndustry: pick(raw, 'subIndustry', 'sub_industry'),
    country: pick(raw, 'country', 'location', 'region'),
    email: pick(raw, 'email', 'email_address'),
    linkedin: pick(raw, 'linkedin', 'linkedin_profile', 'linkedin_url', 'linkedinProfile'),
  };
}

// Turns a prospect into the text we embed / hand to GPT. Uses whatever fields exist.
export function prospectQuery(p: Partial<Prospect>): string {
  return [
    p.industry && `Industry: ${p.industry}`,
    p.subIndustry && `Sub-industry: ${p.subIndustry}`,
    p.companyName && `Company: ${p.companyName}`,
    p.companyWebsite && `Website: ${p.companyWebsite}`,
    p.title && `Role: ${p.title}`,
    p.department && `Department: ${p.department}`,
    p.level && `Seniority: ${p.level}`,
    p.country && `Location: ${p.country}`,
  ]
    .filter(Boolean)
    .join('. ');
}

export async function shortlist(
  p: Partial<Prospect>,
  k = 25
): Promise<{ report: ReportItem; similarity: number }[]> {
  const cat = loadCatalog();
  const dims = cat[0]?.embedding?.length;
  const [qv] = await embed([prospectQuery(p) || 'business report'], dims);
  return cat
    .map((r) => ({ report: r, similarity: cosine(qv, r.embedding as number[]) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

export async function rerank(
  p: Partial<Prospect>,
  cands: { report: ReportItem; similarity: number }[],
  topN = 3
): Promise<ReportMatch[]> {
  const list = cands.map((c, i) => `${i + 1}. ${c.report.title}`).join('\n');
  const sys =
    'You match a B2B prospect to the market-research reports most worth pitching to them. ' +
    "Weigh the buyer's industry/sub-industry if given, otherwise infer the sector from the company " +
    "name and website. Be strict: drop anything off-topic even if it appears in the candidate list. " +
    'Return ONLY valid JSON.';
  const user =
    `PROSPECT:\n${prospectQuery(p)}\n\n` +
    `CANDIDATE REPORTS:\n${list}\n\n` +
    `Return JSON: {"matches":[{"n":<candidate number>,"score":<0-100 fit>,"rationale":"<=18 words"}]}. ` +
    `Choose the best ${topN}, ordered by fit to this buyer's company and (if known) role.`;

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
    /* empty */
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

export async function matchProspect(raw: Record<string, any>, topN = 3): Promise<ReportMatch[]> {
  const p = normalizeProspect(raw);
  const cands = await shortlist(p, 25);
  if (!cands.length) return [];
  return rerank(p, cands, topN);
}
