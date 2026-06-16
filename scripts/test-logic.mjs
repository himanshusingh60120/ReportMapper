// Validates the pure logic used in build-catalog.mjs and match.ts.
// These function bodies are copied verbatim from the source so we test the real logic
// without needing network access (OpenAI / kingsresearch.com).

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
}

// ---- 1) reportIdsFromHtml (verbatim from scripts/build-catalog.mjs) ----------
function reportIdsFromHtml(html) {
  const ids = new Set();
  for (const m of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const mm = m[1].match(/-(\d{3,})\/?(?:[?#][^"']*)?$/);
    if (mm) ids.add(mm[1]);
  }
  return ids;
}

const sampleHtml = `
<nav>
  <a href="https://www.kingsresearch.com/reports/bfsi-11">BFSI</a>
  <a href="https://www.kingsresearch.com/reports/food-and-beverages-1">Food</a>
</nav>
<a href="https://www.kingsresearch.com/report/fintech-as-a-service-market-2892">Fintech as a Service Market Size, Share, 2025-2032</a>
<img src="https://app.kingsresearch.com/uploads/reports/1773984939975-3042.svg" />
<a href="https://www.kingsresearch.com/report/big-data-market-3083">Big Data Market 2026 - 2033</a>
<a href="https://www.kingsresearch.com/agricultural-equipment-finance-market-2313">Legacy URL no /report/</a>
<a href="https://www.kingsresearch.com/report/digital-payment-market-2698/">Trailing slash</a>
<a href="https://www.kingsresearch.com/about-us">About</a>
`;
const ids = reportIdsFromHtml(sampleHtml);
check('extracts /report/ id 2892', ids.has('2892'));
check('extracts id 3083', ids.has('3083'));
check('extracts legacy (no /report/) id 2313', ids.has('2313'));
check('extracts id with trailing slash 2698', ids.has('2698'));
check('ignores category id 11 (BFSI nav link)', !ids.has('11'));
check('ignores category id 1 (Food nav link)', !ids.has('1'));
check('ignores year range 2032 (it is in link text, not an href)', !ids.has('2032'));
check('ignores year range 2033', !ids.has('2033'));
check('ignores /about-us (no numeric id)', ![...ids].some((x) => x === 'about-us'));
check('total distinct report ids === 4', ids.size === 4);

// ---- 2) cosine + nearestIndustryName (verbatim from build-catalog.mjs) -------
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}
function nearestIndustryName(vec, industryVecs) {
  let best = industryVecs[0], bestSim = -Infinity;
  for (const iv of industryVecs) {
    const s = cosine(vec, iv.vec);
    if (s > bestSim) { bestSim = s; best = iv; }
  }
  return best.name;
}
const fakeIndustryVecs = [
  { name: 'BFSI',     vec: [1, 0, 0] },
  { name: 'ICT-IOT',  vec: [0, 1, 0] },
  { name: 'Energy and Power', vec: [0, 0, 1] },
];
check('nearest to [0.9,0.1,0] is BFSI',    nearestIndustryName([0.9, 0.1, 0], fakeIndustryVecs) === 'BFSI');
check('nearest to [0.1,0.95,0.1] is ICT-IOT', nearestIndustryName([0.1, 0.95, 0.1], fakeIndustryVecs) === 'ICT-IOT');
check('nearest to [0,0.2,0.9] is Energy',  nearestIndustryName([0, 0.2, 0.9], fakeIndustryVecs) === 'Energy and Power');

// ---- 3) shortlist industry filter (verbatim slice from lib/match.ts) ---------
function applyIndustryFilter(cat, industryName) {
  let pool = cat;
  if (industryName) {
    const inBucket = cat.filter((r) => r.industry === industryName);
    if (inBucket.length > 0) pool = inBucket;
  }
  return pool;
}
const fakeCatalog = [
  { id: '1', title: 'Digital Banking Platforms Market', industry: 'BFSI' },
  { id: '2', title: 'Risk Analytics Market', industry: 'BFSI' },
  { id: '3', title: 'Big Data Market', industry: 'ICT-IOT' },
  { id: '4', title: 'Solar PV Market', industry: 'Energy and Power' },
];
check('filter to BFSI keeps only 2 reports', applyIndustryFilter(fakeCatalog, 'BFSI').length === 2);
check('filter to BFSI excludes ICT-IOT report', !applyIndustryFilter(fakeCatalog, 'BFSI').some((r) => r.id === '3'));
check('filter to ICT-IOT keeps 1 report', applyIndustryFilter(fakeCatalog, 'ICT-IOT').length === 1);
check('empty bucket falls back to full catalog', applyIndustryFilter(fakeCatalog, 'Agriculture').length === 4);
check('no industry => full catalog', applyIndustryFilter(fakeCatalog, undefined).length === 4);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
