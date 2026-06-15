'use client';

import { useState } from 'react';
import Papa from 'papaparse';

type Prospect = Record<string, string>;
type ReportMatch = {
  report: { id: string; title: string; url: string };
  score: number;
  rationale: string;
};
type Row = {
  prospect: Prospect;
  matches: ReportMatch[];
  verification?: {
    status: 'still_there' | 'likely_left' | 'unknown';
    confidence: number;
    currentCompany?: string;
    currentTitle?: string;
  };
  previousCompanyMatches?: ReportMatch[];
  error?: string;
};

const SAMPLE = `email,first_name,last_name,company_name,phone_number,website,linkedin_profile,location
steven_hunter@swissre.com,Steven,Hunter,Swiss Re,,swissre.com,linkedin.com/in/steven-hunter-9b6b1021,Japan`;

const CHUNK = 3; // small batches keep each request under Vercel's function timeout

function parseRows(text: string): Prospect[] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const out = Papa.parse<Prospect>(text.trim(), { header: true, delimiter, skipEmptyLines: true });
  return out.data;
}

const badgeClass = (s?: string) =>
  s === 'still_there' ? 'b-still' : s === 'likely_left' ? 'b-left' : 'b-unknown';
const badgeText = (s?: string) =>
  s === 'still_there' ? 'still there' : s === 'likely_left' ? 'likely left' : 'unknown';

export default function Page() {
  const [text, setText] = useState(SAMPLE);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  function normalizeEnrich(r: any): Row {
    const { matches, verification, previousCompanyMatches, ...prospect } = r;
    return { prospect, matches, verification, previousCompanyMatches };
  }

  async function run(endpoint: 'match' | 'enrich') {
    setErr('');
    setLoading(true);
    setRows([]);
    try {
      const prospects = parseRows(text);
      if (!prospects.length) throw new Error('No rows parsed — check your header row.');
      const all: Row[] = [];
      for (let i = 0; i < prospects.length; i += CHUNK) {
        const batch = prospects.slice(i, i + CHUNK);
        const res = await fetch(`/api/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prospects: batch }),
        });
        const body = await res.text();
        let data: any;
        try {
          data = JSON.parse(body);
        } catch {
          throw new Error(`Server returned a non-JSON error (HTTP ${res.status}): ${body.slice(0, 200)}`);
        }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        const got: Row[] = endpoint === 'enrich' ? data.results.map(normalizeEnrich) : data.results;
        all.push(...got);
        setRows([...all]); // show progress as each batch finishes
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => setText(String(reader.result || ''));
    reader.readAsText(f);
  }

  function downloadCsv() {
    const flat = rows.map((r) => ({
      first_name: r.prospect.first_name || r.prospect.firstName || '',
      last_name: r.prospect.last_name || r.prospect.lastName || '',
      company: r.prospect.company_name || r.prospect.companyName || '',
      email: r.prospect.email || '',
      status: r.verification ? badgeText(r.verification.status) : '',
      report1: r.matches[0]?.report.title || '',
      report1Url: r.matches[0]?.report.url || '',
      report1Score: r.matches[0]?.score ?? '',
      report2: r.matches[1]?.report.title || '',
      report2Url: r.matches[1]?.report.url || '',
      report3: r.matches[2]?.report.title || '',
      report3Url: r.matches[2]?.report.url || '',
    }));
    const csv = Papa.unparse(flat);
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'matched-prospects.csv';
    a.click();
  }

  return (
    <div className="wrap">
      <h1>Prospect → Report Matcher</h1>
      <p className="sub">
        Paste your prospect sheet (with the header row). Any column names work. Match suggests
        reports; Verify + Match also checks whether the lead is still at the company.
      </p>

      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />

      <div className="row">
        <button disabled={loading} onClick={() => run('match')}>
          {loading ? 'Working…' : 'Match reports'}
        </button>
        <button className="secondary" disabled={loading} onClick={() => run('enrich')}>
          {loading ? 'Working…' : 'Verify + match'}
        </button>
        <label className="muted" style={{ cursor: 'pointer' }}>
          or upload CSV <input type="file" accept=".csv,.tsv,.txt" onChange={onFile} hidden />
        </label>
        {rows.length > 0 && (
          <button className="secondary" onClick={downloadCsv}>
            Download CSV
          </button>
        )}
      </div>

      {err && <p style={{ color: '#b91c1c' }}>{err}</p>}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Status</th>
              <th>Suggested reports</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <strong>
                    {(r.prospect.first_name || r.prospect.firstName || '')}{' '}
                    {(r.prospect.last_name || r.prospect.lastName || '')}
                  </strong>
                  <div className="muted">{r.prospect.title || ''}</div>
                  <div className="muted">{r.prospect.company_name || r.prospect.companyName || ''}</div>
                </td>
                <td>
                  {r.verification ? (
                    <>
                      <span className={`badge ${badgeClass(r.verification.status)}`}>
                        {badgeText(r.verification.status)}
                      </span>
                      {r.verification.currentCompany && (
                        <div className="muted" style={{ marginTop: 4 }}>
                          → {r.verification.currentCompany}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {r.error && <span style={{ color: '#b91c1c' }}>{r.error}</span>}
                  {r.matches.map((m, j) => (
                    <div className="report" key={j}>
                      <a href={m.report.url} target="_blank" rel="noreferrer">
                        {m.report.title}
                      </a>{' '}
                      <span className="score">({m.score})</span>
                      {m.rationale && <div className="why">{m.rationale}</div>}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
