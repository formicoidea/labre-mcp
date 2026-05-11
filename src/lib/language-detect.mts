// Language detection for MCP progress messages
//
// Lightweight heuristic-based language detection from user input text.
// Detects common languages without external dependencies.
// Used to match progress notification messages to the user's language.
//
// Supported languages: en, fr, es, de, pt, it, nl, ja, zh, ko
// Fallback: 'en'

// ─── Language Fingerprints ─────────────────────────────────────────────────
// Common short words and patterns that strongly signal a language.
// Ordered by expected frequency in labre-mcp usage context.

// Words that are common across multiple languages and should be weighted less
const AMBIGUOUS_WORDS = new Set([
  'in', 'de', 'a', 'en', 'la', 'le', 'un', 'van', 'e', 'o', 'i',
  'is', 'on', 'an', 'or', 'as', 'at', 'to', 'for', 'it', 'no',
  'do', 'al', 'el', 'es',
]);

const LANGUAGE_FINGERPRINTS = new Map([
  ['en', {
    // English articles, prepositions, pronouns — weighted to compete with other languages
    words: new Set([
      'the', 'and', 'for', 'that', 'with', 'this', 'from', 'are', 'was',
      'were', 'been', 'have', 'has', 'had', 'will', 'would', 'could',
      'should', 'may', 'might', 'can', 'must', 'shall', 'which', 'what',
      'where', 'when', 'how', 'who', 'whom', 'whose', 'there', 'their',
      'they', 'them', 'these', 'those', 'than', 'then', 'but', 'not',
      'only', 'also', 'into', 'about', 'after', 'before', 'between',
      'through', 'during', 'each', 'every', 'both', 'such', 'used',
      'using', 'because', 'while', 'other', 'some', 'any', 'all',
      'most', 'very', 'just', 'more', 'over', 'own', 'same', 'being',
      'component', 'software', 'business', 'applications', 'service',
      'enterprise', 'market', 'supply', 'chain', 'evolution', 'map',
    ]),
    patterns: [/\b(the|and|with|this|that|from|which|have|been)\b/i],
  }],
  ['fr', {
    // French articles, prepositions, pronouns
    words: new Set([
      'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'est',
      'en', 'dans', 'pour', 'avec', 'sur', 'par', 'ce', 'cette', 'qui',
      'que', 'ne', 'pas', 'plus', 'sont', 'ont', 'nous', 'vous', 'ils',
      'elle', 'son', 'ses', 'aux', 'mais', 'ou', 'donc', 'ni', 'car',
      'je', 'tu', 'il', 'mes', 'tes', 'nos', 'vos', 'leur', 'leurs',
      'quel', 'quelle', 'comme', 'tout', 'tous', 'entre', 'aussi',
      'composant', 'entreprise', 'logiciel', 'carte', 'valeur',
    ]),
    // Accented characters typical of French
    patterns: [/[àâéèêëîïôùûüÿçœæ]/i, /\b(l'|d'|n'|s'|c'|j'|qu')/i],
  }],
  ['es', {
    words: new Set([
      'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'en', 'y',
      'es', 'que', 'por', 'con', 'para', 'como', 'pero', 'su', 'sus',
      'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'al', 'ser',
      'tiene', 'tiene', 'hay', 'puede', 'desde', 'hasta', 'entre',
      'componente', 'empresa', 'software', 'mapa', 'valor', 'cadena',
    ]),
    patterns: [/[áéíóúñ¿¡]/i, /\b(del|al)\b/i],
  }],
  ['de', {
    words: new Set([
      'der', 'die', 'das', 'ein', 'eine', 'und', 'ist', 'in', 'von',
      'zu', 'den', 'mit', 'auf', 'für', 'nicht', 'sich', 'des', 'dem',
      'als', 'auch', 'es', 'an', 'werden', 'aus', 'er', 'hat', 'dass',
      'sie', 'nach', 'wird', 'bei', 'einer', 'eines', 'diesem', 'zum',
      'noch', 'war', 'kann', 'gegen', 'wie', 'durch', 'wenn', 'nur',
      'komponente', 'unternehmen', 'karte', 'wert',
    ]),
    patterns: [/[äöüß]/i, /\b(und|oder|nicht|aber)\b/i],
  }],
  ['pt', {
    words: new Set([
      'o', 'a', 'os', 'as', 'um', 'uma', 'de', 'do', 'da', 'em', 'no',
      'na', 'por', 'com', 'para', 'que', 'se', 'ao', 'ou', 'mais',
      'como', 'mas', 'foi', 'ser', 'tem', 'seu', 'sua', 'dos', 'das',
      'nos', 'nas', 'pelo', 'pela', 'quando', 'muito', 'tambem',
      'componente', 'empresa', 'software', 'mapa', 'valor', 'cadeia',
    ]),
    patterns: [/[ãõçâêô]/i, /\b(não|são|está|também)\b/i],
  }],
  ['it', {
    words: new Set([
      'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di',
      'del', 'della', 'in', 'e', 'che', 'per', 'con', 'su', 'al',
      'dal', 'nel', 'sono', 'come', 'anche', 'questo', 'questa',
      'ha', 'ma', 'non', 'si', 'dei', 'degli', 'alle', 'dalla',
      'componente', 'azienda', 'software', 'mappa', 'valore', 'catena',
    ]),
    patterns: [/\b(della|delle|degli|nell[ao]?)\b/i],
  }],
  ['nl', {
    words: new Set([
      'de', 'het', 'een', 'van', 'en', 'in', 'is', 'dat', 'op', 'te',
      'voor', 'met', 'die', 'niet', 'zijn', 'aan', 'er', 'maar', 'om',
      'ook', 'als', 'nog', 'bij', 'dit', 'wel', 'geen', 'dan', 'uit',
      'wordt', 'kan', 'naar', 'hem', 'hun', 'heeft', 'worden', 'veel',
      'component', 'bedrijf', 'software', 'kaart', 'waarde', 'keten',
    ]),
    patterns: [/\b(het|niet|zijn|hebben|worden)\b/i, /ij/i],
  }],
]);

// CJK and Korean detection via Unicode ranges
const CJK_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const HIRAGANA_KATAKANA = /[\u3040-\u309f\u30a0-\u30ff]/;
const KOREAN_PATTERN = /[\uac00-\ud7af\u1100-\u11ff]/;

// ─── Detection Function ────────────────────────────────────────────────────

/**
 * Detect the language of the given text.
 *
 * Uses a scoring system:
 *   1. Check for CJK/Japanese/Korean character presence (strong signal)
 *   2. Tokenize into words and score against language fingerprints
 *   3. Check regex patterns for accent/grammar signals
 *   4. Return the highest-scoring language, or 'en' as fallback
 *
 * @param {string} text - Input text to analyze
 * @returns {string} ISO 639-1 language code (e.g. 'en', 'fr', 'es')
 */
export function detectLanguage(text: string): string {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return 'en';
  }

  const trimmed = text.trim();

  // ── Quick CJK/Japanese/Korean checks ───────────────────────────────
  if (KOREAN_PATTERN.test(trimmed)) return 'ko';
  if (HIRAGANA_KATAKANA.test(trimmed)) return 'ja';
  if (CJK_PATTERN.test(trimmed)) return 'zh';

  // ── Tokenize ──────────────────────────────────────────────────────
  const words = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  if (words.length === 0) return 'en';

  // ── Score each language ───────────────────────────────────────────
  const scores = new Map();

  for (const [lang, fingerprint] of LANGUAGE_FINGERPRINTS) {
    let score = 0;

    // Word matches: full point for distinctive words, half point for ambiguous ones
    for (const word of words) {
      if (fingerprint.words.has(word)) {
        score += AMBIGUOUS_WORDS.has(word) ? 0.3 : 1;
      }
    }

    // Pattern matches (each pattern = 2 points, stronger signal)
    for (const pattern of fingerprint.patterns) {
      if (pattern.test(trimmed)) {
        score += 2;
      }
    }

    if (score > 0) {
      scores.set(lang, score);
    }
  }

  // ── Pick winner ───────────────────────────────────────────────────
  if (scores.size === 0) return 'en';

  // Normalize by word count to handle different text lengths
  let bestLang = 'en';
  let bestScore = 0;

  for (const [lang, rawScore] of scores) {
    // Require at least ~15% word match rate for short texts,
    // or a minimum absolute score for longer texts
    const matchRate = rawScore / words.length;
    const effectiveScore = rawScore + (matchRate * 10);

    if (effectiveScore > bestScore) {
      bestScore = effectiveScore;
      bestLang = lang;
    }
  }

  // Minimum confidence threshold: at least 2 signals
  const rawBestScore = scores.get(bestLang) || 0;
  if (rawBestScore < 2) return 'en';

  return bestLang;
}

// ─── Extract user text from tool arguments ─────────────────────────────────

/**
 * Extract the most likely user-authored text from MCP tool arguments.
 *
 * Concatenates relevant text fields (name, context, description) to
 * give the language detector enough signal. Field names vary by tool.
 *
 * @param {Object} args - Tool arguments (from any labre-mcp tool)
 * @returns {string} Combined user text for language detection
 */
export function extractUserText(args: Record<string, unknown> | null | undefined): string {
  if (!args || typeof args !== 'object') return '';

  const textFields = [
    args.context,
    args.description,
    args.name,
    args.filePath,
  ];

  return textFields
    .filter(f => typeof f === 'string' && f.trim().length > 0)
    .join(' ')
    .trim();
}

/**
 * Detect language from MCP tool arguments.
 *
 * Convenience function combining extractUserText + detectLanguage.
 *
 * @param {Object} args - Tool arguments
 * @returns {string} Detected language code
 */
export function detectLanguageFromArgs(args: Record<string, unknown> | null | undefined): string {
  const text = extractUserText(args);
  return detectLanguage(text);
}
