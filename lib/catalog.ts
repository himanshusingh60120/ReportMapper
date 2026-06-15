import zlib from 'node:zlib';
import type { ReportItem } from './types';

const SITEMAP =
  process.env.REPORTS_SITEMAP || 'https://www.kingsresearch.com/sitemap-reports.xml';

// Sitemaps are frequently gzipped even with a .xml extension.
export async function fetchSitemapXml(url = SITEMAP): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (catalog-builder)' },
  });
  if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  try {
    return zlib.gunzipSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8'); // already plain XML
  }
}

function prettify(slug: string): string {
  return slug
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bIot\b/g, 'IoT')
    .replace(/\bIct\b/g, 'ICT')
    .replace(/\bBfsi\b/g, 'BFSI')
    .replace(/\bPet\b/g, 'PET')
    .replace(/\bSaas\b/g, 'SaaS');
}

// Pull /report/{slug}-{id} URLs only (skip category, blog, press pages).
export function parseReports(xml: string): ReportItem[] {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const seen = new Set<string>();
  const items: ReportItem[] = [];
  for (const url of locs) {
    const m = url.match(/\/report\/([a-z0-9-]+?)-(\d+)\/?$/i);
    if (!m) continue;
    const slug = m[1];
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ id, slug, url, title: prettify(slug) });
  }
  return items;
}

// Returns the list of sub-sitemap URLs if this is an index file.
export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+\.xml[^<]*)<\/loc>/g)].map((m) => m[1].trim());
}

export async function buildCatalog(url = SITEMAP): Promise<ReportItem[]> {
  const xml = await fetchSitemapXml(url);
  let items = parseReports(xml);
  if (items.length === 0) {
    // It was a sitemap index — recurse into each child sitemap.
    for (const sub of parseSitemapIndex(xml)) {
      items = items.concat(parseReports(await fetchSitemapXml(sub)));
    }
  }
  return items;
}
