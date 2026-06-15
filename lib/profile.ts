import { openai, CHAT_MODEL } from './openai';

export interface CompanyProfile {
  key: string;
  summary: string; // what the company does
  sector: string;  // best-guess industry
  ok: boolean;     // true if we actually read the site
}

// Same company across many rows? Profile once.
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
    const r = await openai.chat.completions.create({
      model: CHAT_MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You read a company website and summarize what the company actually does. Return ONLY JSON.' },
        {
          role: 'user',
          content:
            `COMPANY: ${name}\nWEBSITE TEXT:\n${text}\n\n` +
            `Return JSON: {"summary":"<=40 words: what they do, products, who they serve","sector":"<short industry label e.g. Reinsurance, SaaS, Medical Devices>"}`,
        },
      ],
    });
    let j: any = {};
    try { j = JSON.parse(r.choices[0].message.content || '{}'); } catch { /* empty */ }
    profile = { key, summary: j.summary || name, sector: j.sector || '', ok: true };
  } else {
    profile = { key, summary: name, sector: '', ok: false };
  }

  cache.set(key, profile);
  return profile;
}
