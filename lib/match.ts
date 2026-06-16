import fs from 'node:fs';
import path from 'node:path';
import type { ReportItem, ReportMatch, Prospect } from './types';
import { embed, cosine, openai, CHAT_MODEL } from './openai';
import { profileCompany, CompanyProfile } from './profile';
import { profilePerson, PersonProfile } from './person';
import { INDUSTRIES, industryMenu, resolveIndustry, type Industry } from './industries';

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
  industry: string;        // one of the 12 canonical industries the prospect was bucketed into
  industryReason: string;  // short note on why that bucket was chosen
  personProfile: string;   // what THIS contact most likely does (inferred from title/dept/level)
  personFunction: string;  // short function label, e.g. "Human Resources / Talent"
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
  k = 25,
  industryName?: string,
  person?: PersonProfile
): Promise<{ report: ReportItem; similarity: number }[]> {
  const cat = loadCatalog();
  const dims = cat[0]?.embedding?.length;

  // Hard-filter to the prospect's industry bucket first ("fix the domain, then dig in").
  // Only scope down when the bucket actually has reports, so we never return nothing.
  let pool = cat;
  if (industryName) {
    const inBucket = cat.filter((r) => r.industry === industryName);
    if (inBucket.length > 0) pool = inBucket;
  }

  // Query blends what the COMPANY does with what THIS PERSON does, so within the
  // bucket the reports relevant to the buyer's own function rank higher.
  const q = [
    profile.summary && `Company does: ${profile.summary}`,
    profile.sector && `Sector: ${profile.sector}`,
    p.companyName && `Company: ${p.companyName}`,
    person?.function && `Buyer function: ${person.function}`,
    person?.summary && `Buyer does: ${person.summary}`,
    person?.interests && `Buyer cares about: ${person.interests}`,
    !person?.function && p.title && `Role: ${p.title}`,
    p.country && `Location: ${p.country}`,
  ]
    .filter(Boolean)
    .join('. ');
  const [qv] = await embed([q || p.companyName || 'business report'], dims);
  return pool
    .map((r) => ({ report: r, similarity: cosine(qv, r.embedding as number[]) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, k);
}

// --- Industry classification ("fix the domain first") -----------------------
// Map the prospect's company to exactly one of the 12 fixed Kings Research
// industries before any report matching happens. Primary path is a constrained
// GPT call; if that fails we fall back to nearest industry by embedding so the
// step is never a hard dependency on the model returning clean JSON.

let INDUSTRY_VECS: { industry: Industry; vec: number[] }[] | null = null;

async function industryVectors(dims?: number) {
  if (INDUSTRY_VECS) return INDUSTRY_VECS;
  const texts = INDUSTRIES.map(
    (i) => `${i.name}. ${i.description} Keywords: ${i.keywords.join(', ')}.`
  );
  const vecs = await embed(texts, dims);
  INDUSTRY_VECS = INDUSTRIES.map((industry, i) => ({ industry, vec: vecs[i] }));
  return INDUSTRY_VECS;
}

async function nearestIndustryByEmbedding(text: string, dims?: number): Promise<Industry> {
  const ivs = await industryVectors(dims);
  const [qv] = await embed([text || 'business'], dims);
  let best = ivs[0];
  let bestSim = -Infinity;
  for (const iv of ivs) {
    const s = cosine(qv, iv.vec);
    if (s > bestSim) {
      bestSim = s;
      best = iv;
    }
  }
  return best.industry;
}

export interface IndustryPick {
  industry: Industry;
  reason: string;
}

export async function classifyIndustry(
  p: Partial<Prospect>,
  profile: CompanyProfile
): Promise<IndustryPick> {
  const ctx = [
    p.companyName && `Company: ${p.companyName}`,
    profile.summary && `What they do: ${profile.summary}`,
    profile.sector && `Sector guess: ${profile.sector}`,
    p.industry && `Self-reported industry: ${p.industry}`,
    p.subIndustry && `Self-reported sub-industry: ${p.subIndustry}`,
    p.title && `Contact role: ${p.title}`,
  ]
    .filter(Boolean)
    .join('\n');

  // Primary: constrained GPT classification into one of the 12 buckets.
  try {
    const sys =
      'You are a B2B market-research analyst. Map the company to EXACTLY ONE of the 12 industry ' +
      'buckets listed. Pick the single best fit based on what the company sells/does — never invent a ' +
      'new category and never refuse. Return ONLY JSON.';
    const user =
      `INDUSTRY BUCKETS:\n${industryMenu()}\n\n` +
      `COMPANY:\n${ctx || 'unknown'}\n\n` +
      `Return JSON: {"id":<bucket number 1-12>,"name":"<exact bucket name>","reason":"<=20 words why"}`;
    const r = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
    const j = JSON.parse(r.choices[0].message.content || '{}');
    const byId = Number.isInteger(j.id) ? INDUSTRIES.find((i) => i.id === j.id) : null;
    const resolved = byId || resolveIndustry(j.name);
    if (resolved) {
      return { industry: resolved, reason: typeof j.reason === 'string' ? j.reason : '' };
    }
  } catch {
    /* fall through to the embedding backstop */
  }

  // Backstop: nearest bucket by embedding of the company description.
  const text = [profile.summary, profile.sector, p.industry, p.subIndustry, p.companyName]
    .filter(Boolean)
    .join('. ');
  const industry = await nearestIndustryByEmbedding(text);
  return { industry, reason: 'Nearest industry by semantic similarity (model fallback).' };
}

// Always returns the closest report; confidence reflects how strong the fit is.
async function pickBest(
  p: Partial<Prospect>,
  profile: CompanyProfile,
  cands: { report: ReportItem; similarity: number }[],
  pick: IndustryPick,
  person: PersonProfile
): Promise<BestMatch> {
  const list = cands.map((c, i) => `${i + 1}. ${c.report.title}`).join('\n');
  // Prefer the inferred person profile; fall back to the raw title line if we
  // had nothing person-specific to reason from.
  const personLines =
    person.function || person.summary
      ? `PERSON FUNCTION: ${person.function || 'n/a'}\n` +
        `WHAT THIS PERSON DOES: ${person.summary || roleText(p)}\n` +
        `THEY'D PLAUSIBLY CARE ABOUT: ${person.interests || 'n/a'}\n`
      : `PERSON ROLE: ${roleText(p)}\n`;
  const sys =
    'You are a B2B research analyst. From the candidate market-research reports, pick the SINGLE closest one to ' +
    "pitch to this buyer, weighing BOTH what their company does AND this person's own function/role. ALWAYS choose " +
    'the closest match — never refuse. Set confidence to reflect fit: 80-100 for an obvious fit, 50-79 for a ' +
    'reasonable adjacency, 1-49 when only loosely related. Return ONLY JSON.';
  const user =
    `COMPANY: ${p.companyName || 'unknown'}\n` +
    `WHAT THEY DO: ${profile.summary}\n` +
    `SECTOR: ${profile.sector || 'unknown'}\n` +
    `INDUSTRY BUCKET: ${pick.industry.name}\n` +
    personLines +
    `LOCATION: ${p.country || 'unknown'}\n\n` +
    `CANDIDATE REPORTS (all within ${pick.industry.name}):\n${list}\n\n` +
    `Pick the report that best fits BOTH the company's industry and THIS PERSON's function.\n` +
    `Return JSON: {"n":<closest candidate number 1-${cands.length}>,"confidence":<0-100>,"reasoning":"<=40 words why this is the closest fit for this buyer and their role"}`;

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
    industry: pick.industry.name,
    industryReason: pick.reason,
    personProfile: person.summary,
    personFunction: person.function,
  };
}

export async function bestReportFor(raw: Record<string, any>): Promise<BestMatch> {
  const p = normalizeProspect(raw);
  const profile = await profileCompany(p.companyName || '', p.companyWebsite || '');
  // 1) Fix the domain: bucket the company into one of the 12 industries.
  const pick = await classifyIndustry(p, profile);
  // 1b) Profile the PERSON (name + title + dept + seniority) so the match fits
  //     what THIS contact actually does, not just their employer's industry.
  const person = await profilePerson(p, { summary: profile.summary, sector: profile.sector });
  // 2) Dig deeper: shortlist + re-rank reports *within* that bucket, role-aware.
  const cands = await shortlist(p, profile, 25, pick.industry.name, person);
  if (!cands.length)
    return {
      report: null,
      confidence: 0,
      reasoning: 'Catalog is empty.',
      companyProfile: profile.summary,
      sector: profile.sector,
      industry: pick.industry.name,
      industryReason: pick.reason,
      personProfile: person.summary,
      personFunction: person.function,
    };
  return pickBest(p, profile, cands, pick, person);
}

export async function matchProspect(raw: Record<string, any>, topN = 3): Promise<ReportMatch[]> {
  const p = normalizeProspect(raw);
  const profile = await profileCompany(p.companyName || '', p.companyWebsite || '');
  const pick = await classifyIndustry(p, profile);
  const person = await profilePerson(p, { summary: profile.summary, sector: profile.sector });
  const cands = await shortlist(p, profile, 25, pick.industry.name, person);
  return cands.slice(0, topN).map((c) => ({
    report: { id: c.report.id, title: c.report.title, url: c.report.url },
    score: Math.round(c.similarity * 100),
    similarity: c.similarity,
    rationale: '',
  }));
}
