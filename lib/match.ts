import fs from 'node:fs';
import path from 'node:path';
import type { ReportItem, ReportMatch, Prospect } from './types';
import { embed, cosine, openai, CHAT_MODEL } from './openai';
import { profileCompany, CompanyProfile } from './profile';

let CATALOG: ReportItem[] | null = null;

export function loadCatalog(): ReportItem[] {
  if (CATALOG) return CATALOG;
  const p = path.join(process.cwd(), 'data', 'catalog.json');
  if (!fs.existsSync(p)) throw new Error('data/catalog.json missing. Run scripts/build-catalog.mjs.');
  const raw = fs.readFileSync(p, 'utf8').trim();
  if (!raw) throw new Error('data/catalog.json is empty. Re-run scripts/build-catalog.mjs.');
  CATALOG = JSON.parse(raw) as ReportItem[];
  if (!CATALOG.length || !CATALOG[0].embedding)
    throw new Error('data/catalog.json has no embedded reports. Re-run scripts/build-catalog.mjs.');
  return CATALOG;
}

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

export interface BestMatch {
  report: { id: string; title: string; url: string } | null;
  confidence: number;
  reasoning: string;
  companyProfile: string;
  sector: string;
}

function roleText(p: Partial<Prospect>): string {
  return (
    [p.title && `Title: ${p.title}`, p.department && `Dept: ${p.department}`, p.level && `Level: ${p.level}`]
      .filter(Boolean)
      .join(', ') || 'unknown'
  );
}

async function shortlist(
  p: Partial<Prospect>,
  profile: CompanyProfile,
  k = 25
): Promise<{ report: ReportItem; similarity: number }[]> {
  const cat = loadCatalog();
  const dims = cat[0]?.embedding?.length;
  const q = [
    profile.summary && `Company does: ${profile.summary}`,
    profile.sector && `Sector: ${profile.sector}`,
    p.companyName && `Company: ${p.companyName}`,
    p.title && `Role: ${p.title}`,
    p.country && `Location: ${p.country}`,
  ]
    .filter(Boolean)
    .join('. ');
  const [qv] = await embed([q || p.companyName || 'business report'], dims);
  return cat
    .map((r) => ({ report: r, similarity: cosine(qv, r.embedding as number[]) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

// Always returns the closest report; confidence reflects how strong the fit is.
async function pickBest(
  p: Partial<Prospect>,
  profile: CompanyProfile,
  cands: { report: ReportItem; similarity: number }[]
): Promise<BestMatch> {
  const list = cands.map((c, i) => `${i + 1}. ${c.report.title}`).join('\n');
  const sys =
    'You are a B2B research analyst. From the candidate market-research reports, pick the SINGLE closest one to ' +
    "pitch to this buyer, based on what their company does and the person's role. ALWAYS choose the closest match — " +
    'never refuse. Set confidence to reflect fit: 80-100 for an obvious fit, 50-79 for a reasonable adjacency, ' +
    '1-49 when only loosely related. Return ONLY JSON.';
  const user =
    `COMPANY: ${p.companyName || 'unknown'}\n` +
    `WHAT THEY DO: ${profile.summary}\n` +
    `SECTOR: ${profile.sector || 'unknown'}\n` +
    `PERSON ROLE: ${roleText(p)}\n` +
    `LOCATION: ${p.country || 'unknown'}\n\n` +
    `CANDIDATE REPORTS:\n${list}\n\n` +
    `Return JSON: {"n":<closest candidate number 1-${cands.length}>,"confidence":<0-100>,"reasoning":"<=40 words why this is the closest fit"}`;

  const r = await openai.chat.completions.create({
    model: CHAT_MODEL,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user },
    ],
  });

  let j: any = {};
  try { j = JSON.parse(r.choices[0].message.content || '{}'); } catch { /* empty */ }
  const idx = Number.isInteger(j.n) && j.n >= 1 && j.n <= cands.length ? j.n - 1 : 0; // fall back to top similarity
  const c = cands[idx];
  return {
    report: { id: c.report.id, title: c.report.title, url: c.report.url },
    confidence:
      typeof j.confidence === 'number' ? Math.max(0, Math.min(100, j.confidence)) : Math.round(c.similarity * 100),
    reasoning: j.reasoning || 'Closest available report by topic.',
    companyProfile: profile.summary,
    sector: profile.sector,
  };
}

export async function bestReportFor(raw: Record<string, any>): Promise<BestMatch> {
  const p = normalizeProspect(raw);
  const profile = await profileCompany(p.companyName || '', p.companyWebsite || '');
  const cands = await shortlist(p, profile, 25);
  if (!cands.length)
    return { report: null, confidence: 0, reasoning: 'Catalog is empty.', companyProfile: profile.summary, sector: profile.sector };
  return pickBest(p, profile, cands);
}

export async function matchProspect(raw: Record<string, any>, topN = 3): Promise<ReportMatch[]> {
  const p = normalizeProspect(raw);
  const profile = await profileCompany(p.companyName || '', p.companyWebsite || '');
  const cands = await shortlist(p, profile, 25);
  return cands.slice(0, topN).map((c) => ({
    report: { id: c.report.id, title: c.report.title, url: c.report.url },
    score: Math.round(c.similarity * 100),
    similarity: c.similarity,
    rationale: '',
  }));
}
