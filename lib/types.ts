// Core data shapes for the prospect -> report matcher.

// One row of your prospect sheet (exactly your CSV headers).
export interface Prospect {
  firstName: string;
  lastName: string;
  title: string;
  companyName: string;
  companyWebsite: string;
  department: string;
  level: string;
  industry: string;
  subIndustry: string;
  country: string;
  email: string;
  linkedin: string;
}

// One Kings Research report, parsed from the sitemap and embedded.
export interface ReportItem {
  id: string;        // numeric id at the end of the slug, e.g. "3038"
  slug: string;      // "regtech-market-for-financial-crime-compliance"
  title: string;     // prettified slug
  url: string;       // full report URL
  embedding?: number[]; // present in the built catalog.json
}

// A scored report suggestion for a prospect.
export interface ReportMatch {
  report: { id: string; title: string; url: string };
  score: number;      // 0-100 final fit (GPT)
  similarity: number; // raw cosine 0-1 (embeddings)
  rationale: string;  // one line: why this fits this buyer
}

export type EmploymentStatus = 'still_there' | 'likely_left' | 'unknown';

export interface VerificationResult {
  status: EmploymentStatus;
  confidence: number;            // 0-1
  currentCompany?: string;       // set when likely_left and a new employer is found
  currentTitle?: string;
  evidence: string[];            // which search results / why
  emailDeliverable?: boolean | null; // optional corporate-email signal
  query: string;                 // the boolean query that was run
}

export interface EnrichedProspect extends Prospect {
  verification: VerificationResult;
  matches: ReportMatch[];                 // reports for the CURRENT employer
  previousCompanyMatches?: ReportMatch[]; // old suggestion, kept for reference if they moved
}
