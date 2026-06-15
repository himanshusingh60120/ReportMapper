import { openai, CHAT_MODEL } from './openai';

export interface CompanyProfile {
  key: string;
  summary: string;
  sector: string;
  ok: boolean;
}

const cache = new Map<string, CompanyProfile>();

function domainOf(website: string, name: string): string {
  const d = (website || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  return d || name.trim().toLowerCase();
}

function textFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);
}

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ReportMatcher/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    return textFromHtml(await res.text());
  } catch {
    return '';
  }
}

async function summarize(user: string, sys: string): Promise<{ summary: string; sector: string }> {
  try {
    const r = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: `${sys} Return ONLY JSON.` },
        {
          role: 'user',
          content:
            `${user}\n\nReturn JSON: {"summary":"<=40 words: what they do / most likely do, products, who they serve",` +
            `"sector":"<short industry label, e.g. Reinsurance, Microfinance, EdTech, Higher Education, Semiconductors>"}`,
        },
      ],
    });
    return JSON.parse(r.choices[0].message.content || '{}');
  } catch {
    return { summary: '', sector: '' };
  }
}

export async function profileCompany(name: string, website: string): Promise<CompanyProfile> {
  const key = domainOf(website, name);
  if (cache.has(key)) return cache.get(key)!;

  let text = '';
  const domain = website ? domainOf(website, name) : '';
  if (domain && domain.includes('.')) {
    for (const u of [`https://${domain}`, `https://${domain}/about`]) {
      text = await fetchText(u);
      if (text.length > 300) break;
    }
  }

  let profile: CompanyProfile;
  if (text.length > 200) {
    // Read the real site.
    const j = await summarize(
      `COMPANY: ${name}\nWEBSITE TEXT:\n${text}`,
      'You read a company website and summarize what the company actually does.'
    );
    profile = { key, summary: j.summary || name, sector: j.sector || '', ok: true };
  } else {
    // Site unreadable -> infer from the name + domain using world knowledge.
    const j = await summarize(
      `COMPANY NAME: ${name}\nDOMAIN: ${domain || 'unknown'}\nThe website could not be read; infer the most likely business.`,
      'You infer what a company most likely does from its name and domain. If unsure, give your best guess and a broad sector — never leave it blank.'
    );
    profile = { key, summary: j.summary || name, sector: j.sector || '', ok: false };
  }

  cache.set(key, profile);
  return profile;
}
