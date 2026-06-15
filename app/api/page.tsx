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

const SAMPLE = `firstName\tlastName\ttitle\tcompanyName\tcompanyWebsite\tdepartment\tlevel\tindustry\tsubIndustry\tcountry\temail\tlinkedin
Steven\tHunter\tHead of Pricing L and H Japan\tSwiss Re\tswissre.com\tFinance & Administration\tStaff\tFinancial Services\tInsurance\tJapan\tsteven_hunter@swissre.com\tlinkedin.com/in/steven-hunter-9b6b1021`;

function parseRows(text: string): Prospect[] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const out = Papa.parse<Prospect>(text.trim(), {
    header: true,
    delimiter,
    skipEmptyLines: true,
  });
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

  async function run(endpoint: 'match' | 'enrich') {
    setErr('');
    setLoading(true);
    setRows([]);
    try {
      const prospects = parseRows(text);
      if (!prospects.length) throw new Error('No rows parsed — check your headers.');
      const res = await fetch(`/api/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prospects }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      // /api/enrich returns flat rows; /api/match returns {prospect, matches}
      setRows(endpoint === 'enrich' ? data.results.map(normalizeEnrich) : data.results);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  function normalizeEnrich(r: any): Row {
    const { matches, verification, previousCompanyMatches, ...prospect } = r;
    return { prospect, matches, verification, previousCompanyMatches };
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
      firstName: r.prospect.firstName,
      lastName: r.prospect.lastName,
      company: r.prospect.companyName,
      title: r.prospect.title,
      status: r.verification ? badgeText(r.verification.status) : '',
      currentCompany: r.verification?.currentCompany || '',
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
        Paste your prospect sheet (tab- or comma-separated, with the header row). Match suggests
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
                    {r.prospect.firstName} {r.prospect.lastName}
                  </strong>
                  <div className="muted">{r.prospect.title}</div>
                  <div className="muted">{r.prospect.companyName}</div>
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
