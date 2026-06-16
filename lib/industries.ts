// The 12 fixed industries Kings Research sells reports under.
// Single source of truth lives in data/industries.json so the build script
// (scripts/build-catalog.mjs) and the app agree on the exact buckets.

import industriesData from '@/data/industries.json';

export interface Industry {
  id: number;          // 1..12, matches the numeric suffix on the category-page slug
  name: string;        // canonical display name, e.g. "BFSI" (this is what we tag/export)
  slug: string;        // category-page slug, e.g. "bfsi-11"
  url: string;         // full category-page URL
  description: string; // rich semantic descriptor (used for embedding + LLM classification)
  keywords: string[];  // extra signal words for the classifier prompt
}

export const INDUSTRIES: Industry[] = industriesData as Industry[];

// Canonical names, in catalog order. This is the closed set a prospect is mapped to.
export const INDUSTRY_NAMES: string[] = INDUSTRIES.map((i) => i.name);

// Lower-cased name -> Industry, for tolerant lookups of model output.
const BY_NAME = new Map(INDUSTRIES.map((i) => [i.name.toLowerCase().trim(), i]));

/**
 * Resolve a free-form string (e.g. an LLM's answer) to one of the 12 canonical
 * industries. Tolerates case, surrounding text, common aliases and slug/id forms.
 * Returns null if nothing matches confidently.
 */
export function resolveIndustry(raw: string | null | undefined): Industry | null {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();

  // Exact canonical-name match.
  const exact = BY_NAME.get(s);
  if (exact) return exact;

  // Numeric id ("11") or slug ("bfsi-11").
  const idMatch = s.match(/(?:^|-)(\d{1,2})$/);
  if (idMatch) {
    const byId = INDUSTRIES.find((i) => i.id === Number(idMatch[1]));
    if (byId) return byId;
  }

  // A few common phrasings that don't string-match the canonical names.
  const ALIASES: Record<string, string> = {
    'food & beverages': 'Food and Beverages',
    'food and beverage': 'Food and Beverages',
    'fmcg': 'Consumer Goods',
    'retail': 'Consumer Goods',
    'healthcare': 'Healthcare Medical Devices Biotechnology',
    'pharma': 'Healthcare Medical Devices Biotechnology',
    'pharmaceuticals': 'Healthcare Medical Devices Biotechnology',
    'life sciences': 'Healthcare Medical Devices Biotechnology',
    'medical devices': 'Healthcare Medical Devices Biotechnology',
    'biotechnology': 'Healthcare Medical Devices Biotechnology',
    'chemicals': 'Advanced Materials and Chemicals',
    'materials': 'Advanced Materials and Chemicals',
    'aerospace': 'Aerospace and Defense',
    'defense': 'Aerospace and Defense',
    'defence': 'Aerospace and Defense',
    'semiconductors': 'Semiconductor and Electronics',
    'electronics': 'Semiconductor and Electronics',
    'energy': 'Energy and Power',
    'power': 'Energy and Power',
    'oil and gas': 'Energy and Power',
    'utilities': 'Energy and Power',
    'machinery': 'Machinery Equipment-Construction',
    'construction': 'Machinery Equipment-Construction',
    'industrial': 'Machinery Equipment-Construction',
    'manufacturing': 'Machinery Equipment-Construction',
    'automotive': 'Automotive and Transportation',
    'transportation': 'Automotive and Transportation',
    'logistics': 'Automotive and Transportation',
    'mobility': 'Automotive and Transportation',
    'banking': 'BFSI',
    'financial services': 'BFSI',
    'finance': 'BFSI',
    'insurance': 'BFSI',
    'fintech': 'BFSI',
    'ict': 'ICT-IOT',
    'iot': 'ICT-IOT',
    'it': 'ICT-IOT',
    'it services': 'ICT-IOT',
    'software': 'ICT-IOT',
    'technology': 'ICT-IOT',
    'consulting': 'ICT-IOT',
    'telecom': 'ICT-IOT',
    'cybersecurity': 'ICT-IOT',
  };
  if (ALIASES[s]) return BY_NAME.get(ALIASES[s].toLowerCase()) || null;

  // Substring containment: the model wrote the canonical name inside a sentence.
  for (const ind of INDUSTRIES) {
    if (s.includes(ind.name.toLowerCase())) return ind;
  }

  return null;
}

// A compact, numbered menu of the 12 buckets for use in LLM prompts.
export function industryMenu(): string {
  return INDUSTRIES.map((i) => `${i.id}. ${i.name} — ${i.description}`).join('\n');
}
