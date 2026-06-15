# Prospect → Report Matcher

Matches a list of B2B prospects to the most relevant [Kings Research](https://www.kingsresearch.com)
market-research reports, using the prospect's **company / industry** and **job role**, then
optionally verifies whether the lead is **still at the company** and re-matches if they moved.

Built for Vercel + the OpenAI API.

## How it works

```
Prospect CSV ─┐
              ├─►  Shortlist (embeddings, top 25)  ─►  Re-rank + explain (GPT, top 3)  ─►
Report catalog┘                                                                          │
(sitemap → vectors, built once)                                                          ▼
                                          Verify employment (boolean SERP + email)
                                               │                         │
                                       still at company            left company
                                       (keep reports)          (swap employer, re-match)
                                               └────────────┬────────────┘
                                                            ▼
                                                   Enriched CSV out
```

1. **Catalog build (once, then nightly):** `scripts/build-catalog.mjs` fetches the gzipped
   reports sitemap (~3,000 reports), derives a clean title from each report slug, embeds the
   titles, and writes `data/catalog.json`.
2. **Shortlist:** each prospect row becomes a query (industry + sub-industry + company + role).
   We embed it and take the top 25 reports by cosine similarity — cheap and scalable over 3k reports.
3. **Re-rank:** GPT scores those 25 against the buyer and returns the best 3 with a one-line
   reason. Only 25 titles go in the prompt, so cost per prospect stays tiny.
4. **Verify (optional):** runs a Boolean query — `"First Last" "Company" ("Title")` — through a
   **search-engine API** and lets GPT judge `still_there / likely_left / unknown`, extracting a
   new employer when the person has clearly moved.
5. **Re-match on move:** if they left and a new company is found, we re-run matching on the new
   employer and keep the old suggestion for reference.

## Setup

```bash
npm install
cp .env.example .env.local        # add OPENAI_API_KEY (+ SERPAPI_KEY for verification)
npm run build:catalog             # writes data/catalog.json (needs OPENAI_API_KEY)
npm run dev                       # http://localhost:3000
```

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

- **Tag reports by industry.** Titles alone match well, but crawling the 12 `/reports/{industry}`
  category pages to attach an industry label per report lets you hard-filter the shortlist to the
  buyer's bucket (e.g. BFSI) before re-ranking. Biggest single precision win.
- **Shortlist size (`k`).** Raise to 40 for broad roles, drop to 15 for niche ones.
- **Embed richer text.** Optionally fetch each report's full "By segment" title for more signal
  (costs more at build time, not at query time).
- **Model.** `gpt-4o-mini` is plenty for re-ranking; switch `CHAT_MODEL` to a stronger model only
  if rationales feel thin.

## Cost (rough, OpenAI list prices)

- Catalog build: ~3,000 short embeddings ≈ **$0.01**, run once / nightly.
- Per prospect: 1 embedding + one ~25-line `gpt-4o-mini` call ≈ **$0.001–0.002**.
- 10,000 prospects ≈ a few dollars of OpenAI, plus your SERP API's per-search cost if verifying.

## Files

```
lib/catalog.ts   sitemap → report list (gzip + sitemap-index aware)
lib/openai.ts    OpenAI client, embeddings, cosine
lib/match.ts     shortlist + GPT re-rank
lib/verify.ts    boolean SERP query + GPT employment judgment (pluggable)
app/api/match    POST prospects → report matches
app/api/enrich   POST prospects → verify + (re)match
app/page.tsx     paste/upload UI, results table, CSV download
scripts/build-catalog.mjs   builds data/catalog.json
```
