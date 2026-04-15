/**
 * Embedding generation for function-level semantic search.
 *
 * Strategy (local-first, no API key required):
 *   Default  — @xenova/transformers running Xenova/all-MiniLM-L6-v2 on-device.
 *              Model downloads once (~23 MB) and is cached in ~/.cache/xenova.
 *              dim=384, pure JS/ONNX, no external service needed.
 *
 *   Upgrade  — OpenAI text-embedding-3-small when OPENAI_API_KEY is set.
 *              dim=256, higher quality, costs ~$0.002 per 1M tokens.
 *
 * Text per function (concise — name carries most semantic signal):
 *   "{name} {filename}: {top calls} {short literals}"
 */

import type { SqliteSpecsStore } from "./sqlite-specs-store.js";

const LOCAL_MODEL  = "Xenova/all-MiniLM-L6-v2";
const LOCAL_DIM    = 384;
const OPENAI_MODEL = "text-embedding-3-small";
const OPENAI_DIM   = 256;
const BATCH        = 64; // safe for both local and OpenAI

export interface EmbeddableFunction {
  file: string;
  name: string;
  lines: [number, number];
  calls?: string[];
  stringLiterals?: string[];
}

function fnToText(fn: EmbeddableFunction): string {
  const filename = fn.file.split("/").pop() ?? fn.file;
  const callStr  = (fn.calls ?? []).slice(0, 10).join(" ");
  const litStr   = (fn.stringLiterals ?? []).slice(0, 5).join(" ").slice(0, 100);
  return `${fn.name} ${filename}: ${callStr} ${litStr}`.trim().slice(0, 300);
}

// ── Local embedder (no API key) ───────────────────────────────────────────────

async function embedBatchLocal(
  texts: string[],
  pipe: any,
): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (const text of texts) {
    const result = await pipe(text, { pooling: "mean", normalize: true });
    out.push(new Float32Array(result.data));
  }
  return out;
}

// ── OpenAI embedder (OPENAI_API_KEY required) ─────────────────────────────────

async function embedBatchOpenAI(
  texts: string[],
  apiKey: string,
): Promise<Float32Array[]> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey });
  const response = await client.embeddings.create({
    model: OPENAI_MODEL,
    input: texts,
    dimensions: OPENAI_DIM,
    encoding_format: "float",
  });
  return response.data.map(d => new Float32Array(d.embedding));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed all functions and store them in guardian.db function_embeddings table.
 * Uses local model by default; OpenAI when OPENAI_API_KEY is set (better quality).
 */
export async function embedFunctions(
  store: SqliteSpecsStore,
  fns: EmbeddableFunction[],
  apiKey?: string,
): Promise<void> {
  if (fns.length === 0) return;

  const useOpenAI = !!apiKey;
  let pipe: any;

  if (!useOpenAI) {
    // Lazy-load local model (downloads once, then cached)
    const { pipeline } = await import("@xenova/transformers");
    console.log(`[guardian embed] loading local model ${LOCAL_MODEL}…`);
    pipe = await pipeline("feature-extraction", LOCAL_MODEL);
  }

  const rows: Array<{ file_path: string; name: string; line: number; vec: Float32Array }> = [];

  for (let i = 0; i < fns.length; i += BATCH) {
    const batch = fns.slice(i, i + BATCH);
    const texts = batch.map(fnToText);
    let vecs: Float32Array[];

    try {
      vecs = useOpenAI
        ? await embedBatchOpenAI(texts, apiKey!)
        : await embedBatchLocal(texts, pipe);
    } catch (err) {
      console.warn(`[guardian embed] batch ${i}–${i + batch.length - 1} failed: ${(err as Error).message}`);
      continue;
    }

    for (let j = 0; j < batch.length; j++) {
      if (!vecs[j]) continue;
      rows.push({
        file_path: batch[j].file,
        name:      batch[j].name,
        line:      batch[j].lines[0],
        vec:       vecs[j],
      });
    }

    if (i > 0 && i % 500 === 0) {
      console.log(`[guardian embed] ${i}/${fns.length} functions embedded`);
    }
  }

  store.rebuildEmbeddings(rows);
  const source = useOpenAI ? `OpenAI ${OPENAI_MODEL} dim=${OPENAI_DIM}` : `local ${LOCAL_MODEL} dim=${LOCAL_DIM}`;
  console.log(`[guardian embed] stored ${rows.length} embeddings (${source})`);
}

/**
 * Embed a single query string for hybrid search.
 * Returns null on failure — graceful degradation to BM25 + call-graph authority.
 */
export async function embedQuery(
  query: string,
  apiKey?: string,
): Promise<Float32Array | null> {
  try {
    if (apiKey) {
      const [vec] = await embedBatchOpenAI([query.slice(0, 300)], apiKey);
      return vec ?? null;
    }
    const { pipeline } = await import("@xenova/transformers");
    const pipe = await pipeline("feature-extraction", LOCAL_MODEL);
    const [vec] = await embedBatchLocal([query.slice(0, 300)], pipe);
    return vec ?? null;
  } catch {
    return null;
  }
}
