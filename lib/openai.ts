import OpenAI from 'openai';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Cheap + strong defaults. Override via env if you like.
export const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';
export const CHAT_MODEL = process.env.CHAT_MODEL || 'gpt-4o-mini';
// Fewer dims => much smaller catalog.json, negligible accuracy loss for title matching.
export const EMBED_DIMS = Number(process.env.EMBED_DIMS || 512);

// dims is optional; when set, the API returns vectors of that size (text-embedding-3-* only).
export async function embed(texts: string[], dims: number = EMBED_DIMS): Promise<number[][]> {
  const out: number[][] = [];
  const BATCH = 256;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts
      .slice(i, i + BATCH)
      .map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 8000) || ' ');
    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: batch,
      dimensions: dims,
    });
    for (const d of res.data) out.push(d.embedding as number[]);
  }
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}
