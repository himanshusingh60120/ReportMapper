'use client';

import { useState } from 'react';
import Papa from 'papaparse';

type Prospect = Record<string, string>;
type Best = {
  report: { id: string; title: string; url: string } | null;
  confidence: number;
  reasoning: string;
  companyProfile: string;
  sector: string;
};
type Row = { prospect: Prospect; best: Best | null; error?: string };

const SAMPLE = `email,first_name,last_name,company_name,phone_number,website,linkedin_profile,location
steven_hunter@swissre.com,Steven,Hunter,Swiss Re,,swissre.com,linkedin.com/in/steven-hunter,Japan`;

const CHUNK = 2; // heavier pipeline (website + 2 model calls per row) -> small batches

function parseRows(text: string): Prospect[] {
  const delimiter = text.includes('\t') ? '\t' : ',';
  const out = Papa.parse<Prospect>(text.trim(), { header: true, delimiter, skipEmptyLines: true });
  return out.data;
}

const get = (p: Prospect, ...keys: string[]) => {
  for (const k of keys) if (p[k]) return p[k];
  return '';
};
const confClass = (c: number) => (c >= 75 ? 'b-still' : c >= 50 ? 'b-left' : 'b-unknown');

export default function Page() {
  const [text, setText] = useState(SAMPLE);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function run() {
    setErr('');
    setLoading(true);
    setRows([]);
    try {
      const prospects = parseRows(text);
      if (!prospects.length) throw new Error('No rows parsed — check your header row.');
      const all: Row[] = [];
      for (let i = 0; i < prospects.length; i += CHUNK) {
        const batch = prospects.slice(i, i + CHUNK);
        const res = await fetch('/api/match', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prospects: batch }),
        });
        const body = await res.text();
        let data: any;
        try { data = JSON.parse(body); }
        catch { throw new Error(`Server returned a non-JSON error (HTTP ${res.status}): ${body.slice(0, 200)}`); }
        if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
        all.push(...(data.results as Row[]));
        setRows([...all]);
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
      first_name: get(r.prospect, 'first_name', 'firstName'),
      last_name: get(r.prospect, 'last_name', 'lastName'),
      company: get(r.prospect, 'company_name', 'companyName'),
      email: get(r.prospect, 'email'),
      company_profile: r.best?.companyProfile || '',
      sector: r.best?.sector || '',
      best_report: r.best?.report?.title || '',
      report_url: r.best?.report?.url || '',
      confidence: r.best?.confidence ?? '',
      reasoning: r.best?.reasoning || '',
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
        Paste your sheet (any column names). For each lead it profiles the company from its website,
        weighs the role, and picks the single best report with a confidence score.
      </p>

      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />

      <div className="row">
        <button disabled={loading} onClick={run}>
          {loading ? 'Researching…' : 'Find best report'}
        </button>
        <label className="muted" style={{ cursor: 'pointer' }}>
          or upload CSV <input type="file" accept=".csv,.tsv,.txt" onChange={onFile} hidden />
        </label>
        {rows.length > 0 && (
          <button className="secondary" onClick={downloadCsv}>Download CSV</button>
        )}
      </div>

      {err && <p style={{ color: '#b91c1c' }}>{err}</p>}

      {rows.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Prospect</th>
              <th>Company (researched)</th>
              <th>Best report</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <strong>
                    {get(r.prospect, 'first_name', 'firstName')} {get(r.prospect, 'last_name', 'lastName')}
                  </strong>
                  <div className="muted">{get(r.prospect, 'title')}</div>
                  <div className="muted">{get(r.prospect, 'company_name', 'companyName')}</div>
                </td>
                <td>
                  <div>{r.best?.companyProfile || '—'}</div>
                  {r.best?.sector && <div className="muted" style={{ marginTop: 4 }}>{r.best.sector}</div>}
                </td>
                <td>
                  {r.error && <span style={{ color: '#b91c1c' }}>{r.error}</span>}
                  {r.best?.report ? (
                    <div className="report">
                      <a href={r.best.report.url} target="_blank" rel="noreferrer">{r.best.report.title}</a>{' '}
                      <span className={`badge ${confClass(r.best.confidence)}`}>{r.best.confidence}%</span>
                      {r.best.reasoning && <div className="why">{r.best.reasoning}</div>}
                    </div>
                  ) : (
                    !r.error && <span className="muted">No strong match</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
