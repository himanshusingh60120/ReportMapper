'use client';

import { useState, useRef } from 'react';
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

const CHUNK = 2;

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

function buildCsv(data: Row[]): string {
  const flat = data.map((r) => ({
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
  return Papa.unparse(flat);
}

export default function Page() {
  const [text, setText] = useState(SAMPLE);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [liveName, setLiveName] = useState('');
  const fileHandleRef = useRef<any>(null);

  async function writeLive(data: Row[]) {
    if (!fileHandleRef.current) return;
    try {
      const writable = await fileHandleRef.current.createWritable();
      await writable.write(buildCsv(data));
      await writable.close();
    } catch {
      /* ignore live-save hiccups so the run never breaks */
    }
  }

  async function startLiveSave() {
    const w = window as any;
    if (!w.showSaveFilePicker) {
      setErr('Live-updating file needs Chrome or Edge. The “Download CSV” button works on any browser.');
      return;
    }
    try {
      fileHandleRef.current = await w.showSaveFilePicker({
        suggestedName: 'matched-prospects.csv',
        types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
      });
      setLiveName(fileHandleRef.current.name || 'file');
      setErr('');
      await writeLive(rows); // write whatever we already have
    } catch {
      /* user cancelled the picker */
    }
  }

  async function run() {
    setErr('');
    setLoading(true);
    setRows([]);
    try {
      const prospects = parseRows(text);
      if (!prospects.length) throw new Error('No rows parsed — check your header row.');
      setProgress({ done: 0, total: prospects.length });
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
        setProgress({ done: Math.min(i + CHUNK, prospects.length), total: prospects.length });
        await writeLive(all); // keep the on-disk file in sync after every batch
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
    const blob = new Blob([buildCsv(rows)], { type: 'text/csv' });
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
        weighs the role, and picks the single best report with a confidence score. Results stream in
        as they finish — download a snapshot anytime, or save to a file that updates live.
      </p>

      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />

      <div className="row">
        <button disabled={loading} onClick={run}>
          {loading ? 'Researching…' : 'Find best report'}
        </button>
        {rows.length > 0 && (
          <button className="secondary" onClick={downloadCsv}>
            Download CSV ({rows.length})
          </button>
        )}
        {!liveName ? (
          <button className="secondary" onClick={startLiveSave}>
            Save to live file
          </button>
        ) : (
          <span className="muted">● live → {liveName}</span>
        )}
        <label className="muted" style={{ cursor: 'pointer' }}>
          or upload CSV <input type="file" accept=".csv,.tsv,.txt" onChange={onFile} hidden />
        </label>
      </div>

      {progress.total > 0 && (
        <p className="muted" style={{ marginTop: -8 }}>
          Processed {progress.done} of {progress.total}
          {loading ? ' …' : ' ✓'}
        </p>
      )}

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
