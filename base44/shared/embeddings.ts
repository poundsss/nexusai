// Embedding provider abstraction for project intelligence.
//
// PLATFORM REALITY: the model gateway's only provider (Base44 Core) exposes text generation,
// not an embedding endpoint. So rather than pretending a remote embedding call succeeded, the
// default provider here is a DETERMINISTIC LOCAL embedder: hashed token/bigram projection,
// L2-normalized. It is real, reproducible and useful for ranking (near-duplicate and
// vocabulary-overlap similarity), and it is honestly labelled as such in every stored row.
//
// When a remote embedding provider becomes available it is registered in PROVIDERS and
// selected by name — callers, storage format and retrieval math stay unchanged.

export const EMBEDDING_DIM = 256;
const MAX_CHARS = 8000;

const FNV_OFFSET = 2166136261;
export function hashString(text) {
  let h = FNV_OFFSET;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function hash32(text, seed) {
  let h = FNV_OFFSET ^ seed;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// camelCase / snake_case / path segments all split into words, so `getForecast`,
// `get_forecast` and `functions/getForecast.js` share vocabulary.
export function tokenize(text) {
  return String(text ?? "")
    .slice(0, MAX_CHARS)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && t.length < 40);
}

function localEmbed(text, dim) {
  const tokens = tokenize(text);
  if (!tokens.length) return null;
  const vec = new Array(dim).fill(0);
  const add = (term, weight) => {
    const idx = hash32(term, 1) % dim;
    const sign = hash32(term, 2) % 2 === 0 ? 1 : -1;
    vec[idx] += sign * weight;
  };
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  // Sublinear term weighting: one mention of a rare identifier should not be drowned out by
  // fifty mentions of `const`.
  for (const [t, n] of counts) add(t, 1 + Math.log(n));
  for (let i = 1; i < tokens.length; i++) add(`${tokens[i - 1]}_${tokens[i]}`, 0.5);
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (!norm) return null;
  return vec.map((v) => Number((v / norm).toFixed(6)));
}

const PROVIDERS = {
  "local-hash": {
    id: "local-hash", model: "hash-bigram-v1", remote: false, dim: EMBEDDING_DIM,
    embed: async (texts, dim) => texts.map((t) => localEmbed(t, dim)),
  },
};

export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(-1, Math.min(1, dot));
}

// Batched, retrying embedder with usage accounting. Failures are reported, never faked: a
// text that could not be embedded comes back as null and the caller keeps it lexically
// searchable instead of storing a bogus vector.
export function createEmbedder({ provider = "local-hash", batchSize = 32, retries = 2 } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown embedding provider: ${provider}`);
  const usage = { batches: 0, texts: 0, chars: 0, failures: 0, retries: 0, estimated_cost: 0 };

  const embedBatch = async (texts) => {
    const list = texts.map((t) => String(t ?? ""));
    for (let attempt = 0; ; attempt++) {
      try {
        const out = await p.embed(list, p.dim);
        usage.batches++;
        usage.texts += list.length;
        usage.chars += list.reduce((n, t) => n + Math.min(t.length, MAX_CHARS), 0);
        return out;
      } catch (e) {
        if (attempt >= retries) { usage.failures += list.length; return list.map(() => null); }
        usage.retries++;
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
      }
    }
  };

  return {
    provider: p.id, model: p.model, dim: p.dim, remote: p.remote, usage,
    async embed(text) { return (await embedBatch([text]))[0]; },
    async embedMany(texts) {
      const out = [];
      for (let i = 0; i < texts.length; i += batchSize) out.push(...(await embedBatch(texts.slice(i, i + batchSize))));
      return out;
    },
  };
}