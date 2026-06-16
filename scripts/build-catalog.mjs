// Build the embedded report catalog once (re-run nightly via cron to stay fresh).
//   node scripts/build-catalog.mjs        (reads OPENAI_API_KEY from .env.local automatically)
//
// Each report is tagged with ONE of the 12 fixed industries (data/industries.json):
//   1) authoritatively, by crawling the 12 /reports/{slug}-{n} category pages, then
//   2) for any report a category page didn't surface, by nearest industry via embeddings.
// So every report in catalog.json carries an `industry`, which the matcher hard-filters on.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import OpenAI from 'openai';

// --- load .env.local so you don't have to export the key in the shell (Windows-friendly) ---
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (!process.env.OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY. Put it in .env.local as  OPENAI_API_KEY=sk-...  and re-run.');
  process.exit(1);
}

const SITEMAP =
  process.env.REPORTS_SITEMAP || 'https://www.kingsresearch.com/sitemap-reports.xml';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
const EMBED_DIMS = Number(process.env.EMBED_DIMS || 512); // smaller => smaller catalog file
const CRAWL_INDUSTRIES = process.env.CRAWL_INDUSTRIES !== '0'; // set 0 to skip the category crawl
const MAX_CATEGORY_PAGES = Number(process.env.MAX_CATEGORY_PAGES || 60); // pagination safety cap
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// The 12 fixed industry buckets — single source of truth shared with the app.
const industries = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'data', 'industries.json'), 'utf8')
);

const prettify = (s) =>
  s
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAi\b/g, 'AI')
    .replace(/\bIot\b/g, 'IoT')
    .replace(/\bIct\b/g, 'ICT')
    .replace(/\bBfsi\b/g, 'BFSI')
    .replace(/\bPet\b/g, 'PET')
    .replace(/\bSaas\b/g, 'SaaS');

async function getXml(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (catalog-builder)' } });
  if (!r.ok) throw new Error(`fetch ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  try {
    return zlib.gunzipSync(buf).toString('utf8');
  } catch {
    return buf.toString('utf8');
  }
}

async function getHtml(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (catalog-builder)' } });
    if (!r.ok) return '';
    return await r.text();
  } catch {
    return '';
  }
}

function parse(xml) {
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const seen = new Set();
  const items = [];
  for (const url of locs) {
    const m = url.match(/\/report\/([a-z0-9-]+?)-(\d+)\/?$/i);
    if (!m || seen.has(m[2])) continue;
    seen.add(m[2]);
    items.push({ id: m[2], slug: m[1], url, title: prettify(m[1]) });
  }
  return items;
}

// Pull report ids (3+ digit, to skip the 1-2 digit category ids) out of a page's links.
// Report links look like /report/{slug}-{id} (a few legacy ones drop /report/).
function reportIdsFromHtml(html) {
  const ids = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const mm = m[1].match(/-(\d{3,})\/?(?:[?#][^"']*)?$/);
    if (mm) ids.add(mm[1]);
  }
  return ids;
}

// Crawl one category page (with best-effort ?page=N pagination) -> set of report ids.
async function crawlCategory(ind) {
  const found = new Set();
  for (let page = 1; page <= MAX_CATEGORY_PAGES; page++) {
    const url = page === 1 ? ind.url : `${ind.url}?page=${page}`;
    const html = await getHtml(url);
    if (!html) break;
    const ids = reportIdsFromHtml(html);
    if (page === 1 && ids.size === 0) break; // nothing rendered server-side
    let added = 0;
    for (const id of ids) if (!found.has(id)) (found.add(id), added++);
    if (page > 1 && added === 0) break; // last page, or ?page= is ignored
  }
  return found;
}

// id -> industry name, from the authoritative category pages.
async function buildIndustryMap() {
  const map = new Map();
  for (const ind of industries) {
    try {
      const ids = await crawlCategory(ind);
      for (const id of ids) if (!map.has(id)) map.set(id, ind.name);
      console.log(`  crawled ${ind.name}: ${ids.size} reports`);
    } catch (e) {
      console.warn(`  crawl failed for ${ind.name}: ${e.message}`);
    }
  }
  return map;
}

const round = (x) => Math.round(x * 1e6) / 1e6; // trims the JSON a lot, no real accuracy cost

async function embedAll(texts) {
  const out = [];
  const B = 256;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B).map((t) => t.slice(0, 8000) || ' ');
    const r = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
      dimensions: EMBED_DIMS,
    });
    r.data.forEach((d) => out.push(d.embedding.map(round)));
    console.log(`embedded ${Math.min(i + B, texts.length)}/${texts.length}`);
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

function nearestIndustryName(vec, industryVecs) {
  let best = industryVecs[0];
  let bestSim = -Infinity;
  for (const iv of industryVecs) {
    const s = cosine(vec, iv.vec);
    if (s > bestSim) {
      bestSim = s;
      best = iv;
    }
  }
  return best.name;
}

// ---------------------------------------------------------------------------

const xml = await getXml(SITEMAP);
let items = parse(xml);
if (items.length === 0) {
  // sitemap index -> recurse into child sitemaps
  const subs = [...xml.matchAll(/<loc>([^<]+\.xml[^<]*)<\/loc>/g)].map((m) => m[1].trim());
  for (const s of subs) items = items.concat(parse(await getXml(s)));
}

if (items.length === 0) {
  console.error('No reports parsed from the sitemap — check REPORTS_SITEMAP.');
  process.exit(1);
}
console.log(`found ${items.length} reports (embedding at ${EMBED_DIMS} dims)`);

// 1) Authoritative industry tags from the 12 category pages.
let idToIndustry = new Map();
if (CRAWL_INDUSTRIES) {
  console.log('crawling 12 category pages for authoritative industry tags…');
  idToIndustry = await buildIndustryMap();
  console.log(`tagged ${idToIndustry.size} reports directly from category pages`);
} else {
  console.log('category crawl disabled (CRAWL_INDUSTRIES=0) — using embeddings only');
}

// 2) Embed report titles.
const vecs = await embedAll(items.map((i) => i.title));
items.forEach((it, i) => (it.embedding = vecs[i]));

// 3) Embed the 12 industry descriptors (used to tag whatever the crawl missed).
console.log('embedding 12 industry descriptors…');
const indVecs = await embedAll(
  industries.map((i) => `${i.name}. ${i.description} Keywords: ${i.keywords.join(', ')}.`)
);
const industryVecs = industries.map((ind, i) => ({ name: ind.name, vec: indVecs[i] }));

// 4) Assign an industry to EVERY report: crawl tag if we have it, else nearest by embedding.
let fromCrawl = 0;
let fromEmbed = 0;
for (const it of items) {
  const tagged = idToIndustry.get(it.id);
  if (tagged) {
    it.industry = tagged;
    fromCrawl++;
  } else {
    it.industry = nearestIndustryName(it.embedding, industryVecs);
    fromEmbed++;
  }
}
console.log(`industry tags: ${fromCrawl} from crawl, ${fromEmbed} from embedding fallback`);

const counts = {};
for (const it of items) counts[it.industry] = (counts[it.industry] || 0) + 1;
console.log('reports per industry:');
for (const ind of industries) console.log(`  ${ind.name}: ${counts[ind.name] || 0}`);

fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
const outPath = path.join(process.cwd(), 'data', 'catalog.json');
fs.writeFileSync(outPath, JSON.stringify(items));
const mb = (fs.statSync(outPath).size / 1e6).toFixed(1);
console.log(`wrote data/catalog.json — ${items.length} reports, ${mb} MB`);
