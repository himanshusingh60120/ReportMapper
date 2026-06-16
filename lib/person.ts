import { openai, CHAT_MODEL } from './openai';
import type { Prospect } from './types';

// Profiles the PERSON (not just their company). The company profiler tells us
// what the org sells; this tells us what *this contact* most likely does and
// what kind of market-research they'd care about — so the report we pick fits
// the buyer's actual function, not just their employer's industry.
//
// Important: this is a reasoned INFERENCE from the fields already in the sheet
// (title, department, seniority) plus the company context. It does NOT scrape
// LinkedIn (serverless can't, and it violates LinkedIn's terms — see README).
// If you later wire in a people-data provider (Apollo, People Data Labs,
// Cognism), feed its richer title/bio in as `extra` and the profile sharpens.

export interface PersonProfile {
  summary: string;   // <=35 words: what this person most likely does day-to-day
  function: string;  // short label, e.g. "Human Resources / Talent", "Finance / Treasury"
  interests: string; // <=25 words: market-research themes / vendors relevant to the role
  ok: boolean;       // true when we had enough signal (a title/department) to reason from
}

const cache = new Map<string, PersonProfile>();

function norm(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const GENERIC: PersonProfile = {
  summary: '',
  function: '',
  interests: '',
  ok: false,
};

export async function profilePerson(
  p: Partial<Prospect>,
  company: { summary?: string; sector?: string },
  extra = ''
): Promise<PersonProfile> {
  const title = (p.title || '').trim();
  const department = (p.department || '').trim();
  const level = (p.level || '').trim();

  // Nothing person-specific to reason from -> skip the call, stay generic.
  // (We still match on the company; we just don't claim to know the person.)
  if (!title && !department && !extra.trim()) return GENERIC;

  const key = [norm(p.companyName || ''), norm(title), norm(department), norm(level), norm(extra)].join('|');
  if (cache.has(key)) return cache.get(key)!;

  const who = [
    p.firstName && `Name: ${p.firstName} ${p.lastName || ''}`.trim(),
    title && `Job title: ${title}`,
    department && `Department: ${department}`,
    level && `Seniority: ${level}`,
    p.companyName && `Company: ${p.companyName}`,
    company.summary && `Company does: ${company.summary}`,
    company.sector && `Company sector: ${company.sector}`,
    extra && `Extra context: ${extra}`,
  ]
    .filter(Boolean)
    .join('\n');

  const sys =
    'You are a B2B sales-intelligence analyst. From a contact\'s job title, department and seniority ' +
    'at a known company, infer what THIS PERSON most likely does day-to-day, the business function they sit ' +
    'in, and what kind of market-research reports or vendors would be relevant to their role. Base it on the ' +
    'title — do not overclaim or invent facts you cannot infer. Never refuse. Return ONLY JSON.';
  const user =
    `${who}\n\n` +
    'Return JSON: {' +
    '"summary":"<=35 words: what this person most likely does day-to-day, in their words of their function and seniority",' +
    '"function":"<short function label, e.g. Human Resources / Talent, Finance / Treasury, IT / Engineering & Architecture, Procurement / Supply Chain, Marketing / Growth, Operations, Sales / Business Development, R&D / Product, Executive / General Management, Legal / Compliance, Data / Analytics>",' +
    '"interests":"<=25 words: the market-research themes, categories or vendors this role would plausibly care about buying or tracking"}';

  try {
    const r = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
    });
    const j = JSON.parse(r.choices[0].message.content || '{}');
    const profile: PersonProfile = {
      summary: typeof j.summary === 'string' ? j.summary : '',
      function: typeof j.function === 'string' ? j.function : '',
      interests: typeof j.interests === 'string' ? j.interests : '',
      ok: true,
    };
    cache.set(key, profile);
    return profile;
  } catch {
    // Fall back to a minimal profile built straight from the title so downstream
    // matching still gets *some* role signal even if the model call fails.
    const profile: PersonProfile = {
      summary: title ? `${title}${department ? `, ${department}` : ''}${level ? ` (${level})` : ''}.` : '',
      function: department || title || '',
      interests: '',
      ok: false,
    };
    cache.set(key, profile);
    return profile;
  }
}
