# Prospect → Report Matcher

Matches a list of B2B prospects to the most relevant [Kings Research](https://www.kingsresearch.com)
market-research reports, using the prospect's **company / industry** and **job role**, then
optionally verifies whether the lead is **still at the company** and re-matches if they moved.

Built for Vercel + the OpenAI API.

## How it works

The matcher is **two-stage**: it first decides *which of the 12 Kings Research industries* the
prospect's company belongs to, then digs for the best report **inside that one bucket** — never
across the whole 3k catalog. This mirrors how a human analyst works ("Accenture is an IT /
consulting firm → look in ICT-IOT → pick the report") and is the single biggest precision win.

```
Prospect CSV ─┐
              │   ┌─ 1. Profile company (GPT: what does it do?)
              ├─► ├─ 2. Classify into ONE of the 12 industries  ──┐
Report catalog┘   └─ 3. Shortlist (embeddings) ── within bucket ◄─┘
(sitemap → category-tagged                │
 vectors, built once)                     ▼
                              4. Re-rank + explain (GPT, top 3)
                                          │
                              5. Verify employment (boolean SERP + email)
                                   │                         │
                           still at company            left company
                           (keep reports)          (swap employer, re-match)
                                   └────────────┬────────────┘
                                                ▼
                          Enriched CSV out  (+ industry + industry_reason columns)
```

1. **Catalog build (once, then nightly):** `scripts/build-catalog.mjs` fetches the gzipped
   reports sitemap (~3,000 reports), derives a clean title from each report slug, **crawls the 12
   industry category pages to tag each report with its industry**, embeds the titles, and writes
   `data/catalog.json`. Reports the crawl doesn't reach are tagged by **nearest-industry embedding**,
   so every report always carries an `industry`.
2. **Profile company + person, then classify:** the prospect's **company** is profiled by GPT (one
   line on what it does) and classified into exactly **one** of the 12 industries. The **person** is
   then profiled separately — from their **name, job title, department and seniority** (the columns
   already in your sheet) GPT infers what *this contact* most likely does day-to-day, the **business
   function** they sit in (e.g. *Human Resources / Talent*, *Finance / Treasury*, *IT / Engineering*),
   and the research themes they'd care about. So an HR leader at Accenture and a security architect at
   Accenture get matched differently even though the company bucket (ICT-IOT) is the same. A constrained
   GPT JSON call is the primary classifier; a nearest-industry embedding is the backstop. Free-text
   aliases are normalised here (e.g. *consulting / software / IT → ICT-IOT*, *insurance / fintech → BFSI*).
3. **Shortlist (within bucket, role-aware):** the report catalog is **hard-filtered to the chosen
   industry**, then a query blending *what the company does* with *what the person does* is embedded and
   the top 25 reports by cosine similarity are kept. (If a bucket were ever empty, it safely falls back
   to the full catalog.)
4. **Re-rank:** GPT scores those 25 against the buyer and returns the best 3 with a one-line
   reason. Only 25 titles go in the prompt, so cost per prospect stays tiny.
5. **Verify (optional):** runs a Boolean query — `"First Last" "Company" ("Title")` — through a
   **search-engine API** and lets GPT judge `still_there / likely_left / unknown`, extracting a
   new employer when the person has clearly moved.
6. **Re-match on move:** if they left and a new company is found, we re-run the full classify →
   match pipeline on the new employer and keep the old suggestion for reference.

The chosen industry, the **contact's inferred function**, and the model's one-line reasons are
surfaced in the results table and **exported as CSV columns** (`industry`, `industry_reason`,
`person_function`, `person_profile`) alongside the company profile and matched report.

## Setup

```bash
npm install
cp .env.example .env.local        # add OPENAI_API_KEY (+ SERPAPI_KEY for verification)
npm run build:catalog             # writes data/catalog.json (needs OPENAI_API_KEY)
npm run dev                       # http://localhost:3000
```

> **Re-run `npm run build:catalog` after pulling this change** — the catalog now carries an
> `industry` field per report, and an older `data/catalog.json` won't have it.

The catalog build accepts two optional env vars:

| Var | Default | Effect |
|-----|---------|--------|
| `CRAWL_INDUSTRIES` | `1` | Set to `0` to skip the category-page crawl and tag **every** report by embedding only (faster build, slightly less authoritative). |
| `MAX_CATEGORY_PAGES` | `60` | Pagination ceiling per category page; the crawl stops early once a page adds no new report IDs. |

Paste your sheet (the exact headers below, tab- or comma-separated) and click **Match reports**
or **Verify + match**.

```
firstName  lastName  title  companyName  companyWebsite  department  level  industry  subIndustry  country  email  linkedin
```

## Deploy to Vercel

1. Push this repo to GitHub and import it in Vercel.
2. Add env vars in **Project → Settings → Environment Variables**: `OPENAI_API_KEY`
   (and `SERPAPI_KEY`, `EMAIL_VERIFY_KEY` if using verification).
3. Commit `data/catalog.json` (or generate it in a build step) so it ships with the deployment.
4. Refresh the catalog nightly with a **Vercel Cron Job** that re-runs the build and commits,
   or move the catalog into Vercel Blob / KV and have the build script write there.

## About the "scan LinkedIn" step — read this

You can't fetch LinkedIn profiles from a Vercel function. Serverless runs from datacenter IPs
that LinkedIn blocks on sight (you get a login wall or HTTP `999`), and automated scraping
violates LinkedIn's User Agreement — the largest third-party LinkedIn profile API, Proxycurl,
was shut down in 2025 after LinkedIn legal action.

So this app does the legitimate equivalent: it runs the same Boolean string through a **search
engine's** index (`lib/verify.ts`), where public LinkedIn title text appears in the snippets
lawfully. For higher accuracy, swap `serpSearch()` for a compliant B2B data provider
(People Data Labs, Apollo, Cognism, Lusha) — the interface is identical, just return
`{title, snippet, link}` or set `currentCompany` directly.

## Tuning accuracy

- **Industry bucketing (implemented).** Every report is tagged with one of the 12 industries at
  build time — authoritatively by crawling the `/reports/{industry}-{n}` category pages, with a
  nearest-embedding fallback for any the crawl misses. At query time the company is classified into
  one bucket and the shortlist is **hard-filtered** to it before re-ranking. The 12 industries live
  in `data/industries.json` (the single source of truth); tweak their descriptions/keywords there to
  steer classification. Aliases (e.g. *consulting → ICT-IOT*) live in `lib/industries.ts`.
- **Person profiling (implemented).** `lib/person.ts` infers the contact's function from their
  **name + title + department + seniority** so the matched report fits the buyer's role, not just the
  employer's industry. This is a *reasoned inference from the sheet*, not LinkedIn scraping (serverless
  can't, and it breaks LinkedIn's terms — see above). The name is passed as context but the model is
  told not to fabricate facts it can't infer, so the **title is the reliable signal** — the richer your
  title/department columns, the sharper the profile. To get true web-sourced depth (like a manual
  ChatGPT + people-data lookup), pass a provider's bio/title into `profilePerson(..., extra)`: the
  `extra` slot is built for exactly that, and the **Verify + match** path (`lib/verify.ts`) is the
  natural place to fetch it (Apollo, People Data Labs, Cognism, or a SERP snippet by name + company).
- **Shortlist size (`k`).** Raise to 40 for broad roles, drop to 15 for niche ones.
- **Embed richer text.** Optionally fetch each report's full "By segment" title for more signal
  (costs more at build time, not at query time).
- **Model.** `gpt-4o-mini` is plenty for re-ranking and classification; switch `CHAT_MODEL` to a
  stronger model only if rationales feel thin.

## Cost (rough, OpenAI list prices)

- Catalog build: ~3,000 short embeddings ≈ **$0.01**, run once / nightly.
- Per prospect: 1 embedding + one ~25-line `gpt-4o-mini` call ≈ **$0.001–0.002**.
- 10,000 prospects ≈ a few dollars of OpenAI, plus your SERP API's per-search cost if verifying.

## Files

```
data/industries.json   the 12 Kings Research industries (source of truth: names, urls, keywords)
lib/industries.ts      industry menu + tolerant resolver (aliases, ids, slugs → canonical name)
lib/profile.ts   profiles the COMPANY (reads the site / infers from name) → summary + sector
lib/person.ts    profiles the PERSON from name + title + dept → function + interests (inference, not scraping)
lib/catalog.ts   sitemap → report list (gzip + sitemap-index aware)
lib/openai.ts    OpenAI client, embeddings, cosine
lib/match.ts     classify industry → profile person → filter to bucket → role-aware shortlist + GPT re-rank
lib/verify.ts    boolean SERP query + GPT employment judgment (pluggable)
app/api/match    POST prospects → report matches
app/api/enrich   POST prospects → verify + (re)match
app/page.tsx     paste/upload UI, results table (+ industry badge), CSV download
scripts/build-catalog.mjs   builds data/catalog.json (sitemap + category crawl + industry tagging)
scripts/test-logic.mjs      offline regression tests for the build/match helpers
```
