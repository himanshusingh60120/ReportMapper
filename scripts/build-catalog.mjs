// Build the embedded report catalog once (re-run nightly via cron to stay fresh).
//   node scripts/build-catalog.mjs        (reads OPENAI_API_KEY from .env.local automatically)
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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const vecs = await embedAll(items.map((i) => i.title));
items.forEach((it, i) => (it.embedding = vecs[i]));

fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
const outPath = path.join(process.cwd(), 'data', 'catalog.json');
fs.writeFileSync(outPath, JSON.stringify(items));
const mb = (fs.statSync(outPath).size / 1e6).toFixed(1);
console.log(`wrote data/catalog.json — ${items.length} reports, ${mb} MB`);
