// Build the embedded report catalog once (re-run nightly via cron to stay fresh).
//   OPENAI_API_KEY=sk-... node scripts/build-catalog.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import OpenAI from 'openai';

const SITEMAP =
  process.env.REPORTS_SITEMAP || 'https://www.kingsresearch.com/sitemap-reports.xml';
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
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

async function embedAll(texts) {
  const out = [];
  const B = 256;
  for (let i = 0; i < texts.length; i += B) {
    const batch = texts.slice(i, i + B).map((t) => t.slice(0, 8000) || ' ');
    const r = await openai.embeddings.create({ model: EMBED_MODEL, input: batch });
    r.data.forEach((d) => out.push(d.embedding));
    console.log(`embedded ${Math.min(i + B, texts.length)}/${texts.length}`);
  }
  return out;
}

const xml = await getXml(SITEMAP);
let items = parse(xml);
if (items.length === 0) {
  const subs = [...xml.matchAll(/<loc>([^<]+\.xml[^<]*)<\/loc>/g)].map((m) => m[1].trim());
  for (const s of subs) items = items.concat(parse(await getXml(s)));
}
console.log(`found ${items.length} reports`);

const vecs = await embedAll(items.map((i) => i.title));
items.forEach((it, i) => (it.embedding = vecs[i]));

fs.mkdirSync(path.join(process.cwd(), 'data'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), 'data', 'catalog.json'), JSON.stringify(items));
console.log(`wrote data/catalog.json (${items.length} reports)`);
