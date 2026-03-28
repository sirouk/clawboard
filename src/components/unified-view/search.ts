export const SEARCH_QUERY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "so",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "this",
  "to",
  "we",
  "with",
  "you",
  "your",
]);

const SEARCH_QUERY_MAX_TERMS = 20;
const SEARCH_QUERY_LONG_MAX_TERMS = 32;
const SEARCH_QUERY_LONG_TRIGGER_CHARS = 220;
const SEARCH_QUERY_LONG_TRIGGER_TERMS = 24;
const SEARCH_QUERY_LEXICAL_MAX_CHARS = 260;
const SEARCH_QUERY_SEMANTIC_MAX_CHARS = 640;

export type UnifiedSearchPlan = {
  raw: string;
  normalized: string;
  lexicalQuery: string;
  semanticQuery: string;
  terms: string[];
  phraseShards: string[];
  isLong: boolean;
};

export type SemanticConfidenceOptions = {
  absoluteFloor: number;
  relativeFloor: number;
  maxCount: number;
};

export type ScoredSemanticMatch = {
  id: string;
  score: number;
  sessionBoosted?: boolean;
};

function tokenizeSearchQuery(query: string, maxTerms: number) {
  const normalized = String(query ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s/_:-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return [];
  const stats = new Map<string, { count: number; firstIndex: number }>();
  let tokenIndex = 0;
  for (const token of normalized.split(/\s+/)) {
    const term = token.trim().replace(/^[:/_-]+|[:/_-]+$/g, "");
    if (term.length < 2) continue;
    if (SEARCH_QUERY_STOPWORDS.has(term)) continue;
    const stat = stats.get(term);
    if (stat) {
      stat.count += 1;
    } else {
      stats.set(term, { count: 1, firstIndex: tokenIndex });
    }
    tokenIndex += 1;
  }
  const ranked = Array.from(stats.entries())
    .map(([term, stat]) => {
      const lengthBoost = Math.min(0.55, Math.max(0, term.length - 2) * 0.045);
      const freqBoost = Math.min(0.45, Math.max(0, stat.count - 1) * 0.16);
      const shapeBoost = /[0-9/:_-]/.test(term) ? 0.2 : 0;
      const earlyBoost = Math.max(0, 0.28 - Math.min(0.28, stat.firstIndex / 120));
      const score = 1 + lengthBoost + freqBoost + shapeBoost + earlyBoost;
      return { term, score, firstIndex: stat.firstIndex, count: stat.count };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.count !== a.count) return b.count - a.count;
      if (a.firstIndex !== b.firstIndex) return a.firstIndex - b.firstIndex;
      return a.term.localeCompare(b.term);
    });
  return ranked.slice(0, Math.max(1, maxTerms)).map((item) => item.term);
}

function extractPhraseShards(rawQuery: string, maxShards = 2) {
  const normalized = String(rawQuery ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return [];
  const sentences = normalized
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const shards: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length < 18) continue;
    const clipped = sentence.slice(0, 180).trim();
    if (!clipped) continue;
    if (shards.includes(clipped)) continue;
    shards.push(clipped);
    if (shards.length >= maxShards) break;
  }
  if (shards.length === 0 && normalized.length >= 40) {
    shards.push(normalized.slice(0, 180).trim());
  }
  return shards.slice(0, maxShards);
}

export function buildUnifiedSearchPlan(rawQuery: string): UnifiedSearchPlan {
  const raw = String(rawQuery ?? "").replace(/\s+/g, " ").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return {
      raw: "",
      normalized: "",
      lexicalQuery: "",
      semanticQuery: "",
      terms: [],
      phraseShards: [],
      isLong: false,
    };
  }

  const rankedTerms = tokenizeSearchQuery(normalized, SEARCH_QUERY_LONG_MAX_TERMS);
  const isLong =
    normalized.length >= SEARCH_QUERY_LONG_TRIGGER_CHARS || rankedTerms.length >= SEARCH_QUERY_LONG_TRIGGER_TERMS;
  const terms = rankedTerms.slice(0, isLong ? SEARCH_QUERY_LONG_MAX_TERMS : SEARCH_QUERY_MAX_TERMS);
  const lexicalQuery = (
    isLong
      ? (terms.slice(0, SEARCH_QUERY_MAX_TERMS).join(" ").trim() || normalized.slice(0, SEARCH_QUERY_LEXICAL_MAX_CHARS))
      : normalized
  )
    .slice(0, SEARCH_QUERY_LEXICAL_MAX_CHARS)
    .trim();
  const phraseShards = isLong ? extractPhraseShards(raw, 3) : [];
  const semanticParts = [
    ...phraseShards.slice(0, 2),
    terms.slice(0, SEARCH_QUERY_LONG_MAX_TERMS).join(" ").trim(),
  ].filter(Boolean);
  const semanticQuery = (isLong ? semanticParts.join(" ").trim() : normalized)
    .slice(0, SEARCH_QUERY_SEMANTIC_MAX_CHARS)
    .trim();
  const semanticEffective = semanticQuery || lexicalQuery || normalized;
  return {
    raw,
    normalized,
    lexicalQuery: lexicalQuery || normalized,
    semanticQuery: semanticEffective,
    terms,
    phraseShards,
    isLong,
  };
}

export function pickConfidentSemanticIds(
  matches: readonly ScoredSemanticMatch[] | undefined,
  options: SemanticConfidenceOptions
) {
  const ranked = (matches ?? [])
    .map((item) => ({
      id: String(item.id ?? "").trim(),
      score: Number(item.score) || 0,
      sessionBoosted: item.sessionBoosted === true,
    }))
    .filter((item) => item.id && (item.sessionBoosted || item.score > 0))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.sessionBoosted !== b.sessionBoosted) return a.sessionBoosted ? -1 : 1;
      return a.id.localeCompare(b.id);
    });

  if (ranked.length === 0) return new Set<string>();

  const topScore = ranked[0]?.score ?? 0;
  const floor = Math.max(options.absoluteFloor, topScore * options.relativeFloor);
  const ids = new Set<string>();

  for (const item of ranked.slice(0, Math.max(1, options.maxCount))) {
    if (!item.sessionBoosted && item.score < floor) continue;
    ids.add(item.id);
  }

  if (ids.size === 0 && ranked[0]?.id) {
    ids.add(ranked[0].id);
  }

  return ids;
}

export function matchesSearchText(haystackRaw: string, plan: UnifiedSearchPlan) {
  const haystack = String(haystackRaw ?? "").toLowerCase();
  if (!plan.normalized) return true;
  if (haystack.includes(plan.normalized)) return true;
  if (plan.lexicalQuery && haystack.includes(plan.lexicalQuery)) return true;
  if (plan.phraseShards.some((shard) => shard.length >= 20 && haystack.includes(shard))) return true;
  if (plan.terms.length === 0) return false;
  let hits = 0;
  for (const term of plan.terms) {
    if (!haystack.includes(term)) continue;
    hits += 1;
  }
  const requiredHits = plan.isLong
    ? Math.min(3, Math.max(1, Math.ceil(plan.terms.length * 0.14)))
    : plan.terms.length <= 2
      ? plan.terms.length
      : plan.terms.length <= 5
        ? 2
        : 3;
  return hits >= requiredHits;
}

export function scoreSearchText(haystackRaw: string, plan: UnifiedSearchPlan) {
  const haystack = String(haystackRaw ?? "").toLowerCase();
  if (!plan.normalized || !haystack) return 0;

  let score = 0;
  if (haystack.includes(plan.normalized)) {
    score += 3;
  } else if (plan.lexicalQuery && haystack.includes(plan.lexicalQuery)) {
    score += 2.4;
  }

  for (const shard of plan.phraseShards) {
    if (shard.length < 20) continue;
    if (!haystack.includes(shard)) continue;
    score += 1.2;
  }

  let hits = 0;
  let weightedHits = 0;
  for (const term of plan.terms) {
    if (!haystack.includes(term)) continue;
    hits += 1;
    weightedHits += Math.min(0.85, 0.34 + Math.max(0, term.length - 2) * 0.045);
  }

  if (hits > 0) {
    score += Math.min(2.6, weightedHits);
    score += Math.min(0.9, hits / Math.max(1, plan.terms.length));
  }

  if (score > 0 && haystack.startsWith(plan.normalized)) {
    score += 0.35;
  }

  return Number(score.toFixed(4));
}

export function describeSemanticSearchMode(mode: string) {
  const normalized = String(mode ?? "").trim().toLowerCase();
  if (!normalized) return "smart search";
  if (normalized.includes("qdrant") || normalized.includes("semantic")) return "smart search";
  if (normalized.includes("bm25") || normalized.includes("lexical")) return "keyword search";
  return "smart search";
}
