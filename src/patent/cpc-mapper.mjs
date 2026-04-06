// CPC Mapper: translate Wardley component capabilities into CPC sub-class codes.
//
// Three resolution paths:
//   1. llmMapCapabilityToCPC(capability) — focused LLM mapping returning 1-5 validated codes
//   2. LLM-assisted mapping via mapComponentToCpc(component, llmCall?) — contextual mapping
//   3. Hardcoded fallback (CPC_FALLBACK_MAP) — keyword-matched lookup for ~20 common capabilities
//
// The fallback map covers the most common components found in Wardley maps,
// each mapped to one or more 4-character CPC sub-class codes (e.g. 'G06F', 'H04L').
// These codes correspond to the Cooperative Patent Classification hierarchy:
//   Section (1 letter A–H,Y) + Class (2 digits) + Subclass (1 letter)
//
// Pipeline integration:
//   cpc-evolution-strategy.mjs calls llmMapCapabilityToCPC(capability) or
//   mapComponentToCpc(component, llmCall?) which tries LLM first, falls back
//   to CPC_FALLBACK_MAP on failure or absence.

import { createLLMCall } from '../llm-call.mjs';

// ─── CPC code validation ───────────────────────────────────────────────────────

/**
 * Regex for a valid 4-character CPC sub-class code.
 * Format: one letter (A–H or Y) + two digits + one letter.
 * Examples: G06F, H04L, B33Y, A61K
 */
export const CPC_CODE_REGEX = /^[A-HY]\d{2}[A-Z]$/;

/**
 * Validate a CPC code string.
 * @param {string} code
 * @returns {boolean} true if valid 4-char CPC sub-class code
 */
export function isValidCpcCode(code) {
  return typeof code === 'string' && CPC_CODE_REGEX.test(code);
}

// ─── Hardcoded fallback map ────────────────────────────────────────────────────

/**
 * CPC_FALLBACK_MAP — hardcoded lookup mapping ~20 common Wardley capabilities
 * to their 4-character CPC sub-class codes.
 *
 * Keys are lowercase capability keywords as they would appear from the
 * identify-capability.mjs pipeline (activities, practices, technologies).
 * Values are arrays of CPC sub-class codes (a capability may span multiple classes).
 *
 * CPC reference:
 *   G06F  Electric digital data processing (OS, containers, databases, NLP)
 *   G06N  Computing arrangements based on specific computational models (AI/ML)
 *   G06Q  Data processing for admin/commercial/financial purposes (CRM, ERP, payments)
 *   G06V  Image or video recognition or understanding (computer vision)
 *   H04L  Transmission of digital information (networking, crypto, web, CDN, blockchain)
 *   H04W  Wireless communication networks (WiFi, 5G, cellular)
 *   H04N  Pictorial communication (video streaming, broadcast)
 *   H01L  Semiconductor devices (chip manufacturing)
 *   H01M  Chemical-to-electrical energy conversion (batteries, fuel cells)
 *   H02J  Circuit arrangements for electric power (power distribution, grid)
 *   B25J  Manipulators (robotics, mechanical arms)
 *   B33Y  Additive manufacturing (3D printing)
 *   B60W  Conjoint control of vehicle sub-units (autonomous vehicles)
 *   G01S  Radio direction-finding; radio navigation (GPS, radar, lidar)
 *   G01D  Measuring not specially adapted for a specific variable (sensors)
 *   A61K  Preparations for medical/dental/toilet purposes (pharmaceuticals)
 *   C12N  Micro-organisms or enzymes; compositions thereof (biotech)
 *   F24S  Solar heat collectors (solar energy)
 *
 * @type {Record<string, string[]>}
 */
export const CPC_FALLBACK_MAP = {
  // ── Computing & infrastructure ───────────────────────────────────────────
  'cloud computing':              ['G06F', 'H04L'],
  'compute':                      ['G06F'],
  'container orchestration':      ['G06F'],
  'orchestrate containers':       ['G06F'],
  'virtualization':               ['G06F'],
  'operating system':             ['G06F'],
  'serverless':                   ['G06F', 'H04L'],

  // ── Data & storage ──────────────────────────────────────────────────────
  'database':                     ['G06F'],
  'data storage':                 ['G06F'],
  'store data':                   ['G06F'],
  'data analytics':               ['G06F', 'G06Q'],
  'analyze data':                 ['G06F', 'G06Q'],

  // ── Networking & web ────────────────────────────────────────────────────
  'network communication':        ['H04L'],
  'web server':                   ['H04L'],
  'serve web content':            ['H04L'],
  'content delivery':             ['H04L', 'H04N'],
  'deliver content':              ['H04L', 'H04N'],
  'wireless communication':       ['H04W'],

  // ── Security & identity ─────────────────────────────────────────────────
  'encryption':                   ['H04L'],
  'encrypt data':                 ['H04L'],
  'cybersecurity':                ['H04L', 'G06F'],
  'authentication':               ['H04L', 'G06F'],
  'authenticate users':           ['H04L', 'G06F'],

  // ── AI & machine learning ───────────────────────────────────────────────
  'machine learning':             ['G06N'],
  'artificial intelligence':      ['G06N'],
  'natural language processing':  ['G06F', 'G06N'],
  'process natural language':     ['G06F', 'G06N'],
  'computer vision':              ['G06V', 'G06N'],
  'recognize images':             ['G06V', 'G06N'],

  // ── Business processes ──────────────────────────────────────────────────
  'manage customer relationships': ['G06Q'],
  'customer relationship management': ['G06Q'],
  'payment processing':           ['G06Q'],
  'process payments':             ['G06Q'],
  'supply chain management':      ['G06Q'],
  'manage supply chain':          ['G06Q'],
  'enterprise resource planning': ['G06Q'],

  // ── Hardware & manufacturing ────────────────────────────────────────────
  'semiconductor':                ['H01L'],
  'battery':                      ['H01M'],
  'energy storage':               ['H01M'],
  'store energy':                 ['H01M'],
  'power generation':             ['H02J'],
  'generate power':               ['H02J'],
  'additive manufacturing':       ['B33Y', 'B29C'],
  '3d printing':                  ['B33Y', 'B29C'],
  'robotics':                     ['B25J'],
  'sensor':                       ['G01D'],

  // ── Emerging tech ───────────────────────────────────────────────────────
  'blockchain':                   ['H04L'],
  'distributed ledger':           ['H04L'],
  'autonomous vehicle':           ['B60W', 'G05D'],
  'gps navigation':               ['G01S'],
  'navigate':                     ['G01S'],

  // ── Domain-specific ─────────────────────────────────────────────────────
  'pharmaceutical':               ['A61K'],
  'biotechnology':                ['C12N'],
  'solar energy':                 ['F24S'],
  'video streaming':              ['H04N', 'H04L'],
  'stream video':                 ['H04N', 'H04L'],
};

// ─── Keyword matching engine ───────────────────────────────────────────────────

/**
 * Normalize a string for fuzzy keyword matching:
 * lowercase, collapse whitespace, strip punctuation.
 * @param {string} s
 * @returns {string}
 */
function normalize(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score how well a candidate key matches a query string.
 * Returns 0 (no match) to 1 (exact match).
 *
 * Matching strategy (in priority order):
 *   1. Exact match → 1.0
 *   2. Query contains the key verbatim → 0.9
 *   3. Key contains the query verbatim → 0.8
 *   4. All words in the key appear in the query → 0.7
 *   5. Majority of key words appear in query → proportional 0.3–0.6
 *
 * @param {string} normalizedKey - Normalized map key
 * @param {string} normalizedQuery - Normalized search query
 * @returns {number} Match score in [0, 1]
 */
function matchScore(normalizedKey, normalizedQuery) {
  if (normalizedKey === normalizedQuery) return 1.0;
  if (normalizedQuery.includes(normalizedKey)) return 0.9;
  if (normalizedKey.includes(normalizedQuery)) return 0.8;

  const keyWords = normalizedKey.split(' ');
  const matchedCount = keyWords.filter(w => normalizedQuery.includes(w)).length;

  if (matchedCount === keyWords.length) return 0.7;
  if (matchedCount === 0) return 0;

  // Proportional partial match
  return 0.3 + (matchedCount / keyWords.length) * 0.3;
}

/**
 * Look up CPC codes from the hardcoded fallback map using fuzzy keyword matching.
 * Returns the best match above threshold, or empty array if no match.
 *
 * @param {string} capability - Component capability text
 * @param {number} [threshold=0.5] - Minimum match score to accept
 * @returns {{ codes: string[], matchedKey: string, score: number } | null}
 */
export function lookupFallback(capability, threshold = 0.5) {
  const query = normalize(capability);
  if (!query) return null;

  let bestMatch = null;
  let bestScore = 0;

  for (const [key, codes] of Object.entries(CPC_FALLBACK_MAP)) {
    const score = matchScore(normalize(key), query);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { codes, matchedKey: key, score };
    }
  }

  if (bestMatch && bestMatch.score >= threshold) {
    return bestMatch;
  }

  return null;
}

// ─── LLM-assisted CPC mapping ─────────────────────────────────────────────────

const CPC_MAPPER_PROMPT = `You are a patent classification expert. Given a technology capability, identify the most relevant CPC (Cooperative Patent Classification) sub-class codes.

CPC sub-class codes are exactly 4 characters: one section letter (A-H or Y), two digits, and one letter.
Examples: G06F, H04L, B33Y, A61K

Capability: {{capability}}
Component: {{component}}
Context: {{context}}

Return ONLY the CPC codes, one per line, most relevant first. Return 1-3 codes maximum.
Do not include any other text, explanation, or formatting.`;

/**
 * Ask an LLM to produce CPC sub-class codes for a capability.
 * Validates all returned codes with the CPC_CODE_REGEX.
 *
 * @param {string} capability - Component capability text
 * @param {string} componentName - Component name for context
 * @param {string} context - Additional context
 * @param {function(string): Promise<string>} llmCall - LLM call function
 * @returns {Promise<string[]>} Array of valid 4-char CPC codes
 */
async function llmMapToCpc(capability, componentName, context, llmCall) {
  const prompt = CPC_MAPPER_PROMPT
    .replace('{{capability}}', capability || '')
    .replace('{{component}}', componentName || '')
    .replace('{{context}}', context || '');

  const response = await llmCall(prompt);

  // Extract all 4-char CPC codes from response, validate each
  const candidates = response
    .split(/[\s,;\n]+/)
    .map(s => s.trim().toUpperCase())
    .filter(isValidCpcCode);

  // Deduplicate while preserving order (most relevant first)
  return [...new Set(candidates)];
}

// ─── Standalone LLM-assisted CPC mapping ──────────────────────────────────────
//
// llmMapCapabilityToCPC is the primary exported API for Sub-AC 2.
// Unlike the internal llmMapToCpc helper, it:
//   • Takes a single capability string (minimal interface)
//   • Creates its own LLM call if none injected (self-contained)
//   • Uses strict /^[A-H]\d{2}[A-Z]$/ regex (excludes Y tagging section)
//   • Returns 1-5 codes (broader range than the 1-3 of internal helper)

/**
 * Strict regex for primary CPC sub-class codes (sections A–H only).
 * Excludes the Y tagging section used for cross-referencing.
 * Format: one letter (A–H) + two digits + one letter.
 */
export const CPC_PRIMARY_REGEX = /^[A-H]\d{2}[A-Z]$/;

const LLM_CPC_CAPABILITY_PROMPT = `You are a patent classification expert specializing in the Cooperative Patent Classification (CPC) system.

Given a technology capability or component, identify the 1-5 most relevant CPC sub-class codes that would cover patents in this technology area.

CPC sub-class codes are exactly 4 characters:
- One section letter from A through H (NOT Y)
- Two digits (00-99)
- One uppercase letter (A-Z)

Sections:
  A = Human Necessities
  B = Performing Operations; Transporting
  C = Chemistry; Metallurgy
  D = Textiles; Paper
  E = Fixed Constructions
  F = Mechanical Engineering; Lighting; Heating; Weapons
  G = Physics (includes computing G06, measuring G01)
  H = Electricity (includes telecom H04, semiconductors H01)

Capability: {{capability}}

Return ONLY valid CPC sub-class codes, one per line, most relevant first.
Return between 1 and 5 codes. Do not include explanations, bullets, or formatting.`;

/**
 * Map a capability string to CPC sub-class codes via LLM.
 *
 * Calls the LLM with a focused prompt and validates each returned code
 * against /^[A-H]\d{2}[A-Z]$/, filtering out invalid entries.
 *
 * @param {string} capability - Technology capability or component description
 * @param {function(string, Object?): Promise<string>} [llmCall]
 *   Optional injected LLM call function. If omitted, creates one via createLLMCall().
 * @returns {Promise<string[]>} Array of 1-5 valid CPC sub-class codes (may be empty if LLM fails)
 */
export async function llmMapCapabilityToCPC(capability, llmCall) {
  if (!capability || typeof capability !== 'string' || !capability.trim()) {
    return [];
  }

  // Use injected llmCall or create a default one (low-cost, focused call)
  const callLLM = typeof llmCall === 'function'
    ? llmCall
    : createLLMCall({ effort: 'low', maxBudgetUsd: 0.02 });

  const response = await callLLM(LLM_CPC_CAPABILITY_PROMPT, {
    capability: capability.trim(),
  });

  // Parse response: split on whitespace/punctuation, uppercase, validate
  const candidates = response
    .split(/[\s,;\n\r\-–—•·|/]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => s.length > 0)
    .filter(code => CPC_PRIMARY_REGEX.test(code));

  // Deduplicate while preserving relevance order, cap at 5
  return [...new Set(candidates)].slice(0, 5);
}

// ─── Main orchestrator ────────────────────────────────────────────────────────
//
// mapCapabilityToCPC is the primary public API for the CPC mapping pipeline.
// It guarantees a 1-5 element array of valid CPC codes, using a cascading
// resolution strategy: LLM → hardcoded fallback → ultimate default.

/**
 * Default CPC code returned when both LLM and fallback produce nothing.
 * G06F (Electric digital data processing) is the broadest tech class
 * and covers the majority of Wardley map components.
 * @type {string[]}
 */
const ULTIMATE_DEFAULT_CODES = ['G06F'];

/**
 * Map a capability string to 1-5 CPC sub-class codes.
 *
 * Orchestration:
 *   1. Try llmMapCapabilityToCPC → validated codes via LLM
 *   2. On empty or error → lookupFallback via CPC_FALLBACK_MAP keyword matching
 *   3. On still empty → ULTIMATE_DEFAULT_CODES (G06F)
 *
 * **Return contract:** Always returns an array with 1-5 elements.
 * Never throws, never returns empty, never exceeds 5 elements.
 *
 * @param {string} capability - Technology capability or component description
 * @param {Object} [options]
 * @param {function(string, Object?): Promise<string>} [options.llmCall]
 *   Optional injected LLM call function for testing. If omitted,
 *   llmMapCapabilityToCPC creates its own via createLLMCall().
 * @returns {Promise<string[]>} Array of 1-5 valid 4-char CPC sub-class codes
 */
export async function mapCapabilityToCPC(capability, options = {}) {
  const cap = (typeof capability === 'string' ? capability : '').trim();

  // ── Path 1: LLM-assisted mapping ──────────────────────────────────────────
  if (cap) {
    try {
      const llmCodes = await llmMapCapabilityToCPC(cap, options.llmCall);
      if (llmCodes.length > 0) {
        // llmMapCapabilityToCPC already caps at 5, but enforce contract
        return llmCodes.slice(0, 5);
      }
    } catch {
      // LLM failed — fall through to hardcoded fallback
    }
  }

  // ── Path 2: Hardcoded fallback via keyword matching ───────────────────────
  if (cap) {
    const fallback = lookupFallback(cap);
    if (fallback && fallback.codes.length > 0) {
      return fallback.codes.slice(0, 5);
    }
  }

  // ── Path 3: Ultimate default — guarantee non-empty return ─────────────────
  return [...ULTIMATE_DEFAULT_CODES];
}

// ─── Main entry point (component-level) ───────────────────────────────────────

/**
 * Map a component to CPC sub-class codes.
 *
 * Resolution order:
 *   1. LLM-assisted mapping (if llmCall provided) → validated codes
 *   2. Hardcoded fallback (CPC_FALLBACK_MAP) → keyword-matched codes
 *   3. Empty array (no mapping found)
 *
 * @param {import('../strategies/base-strategy.mjs').ComponentInput} component
 *   Component with at least .name; optionally .capability, .description, .context
 * @param {function(string): Promise<string>} [llmCall]
 *   Optional LLM call function. If absent, only fallback is used.
 * @returns {Promise<string[]>} Array of valid 4-char CPC sub-class codes
 */
export async function mapComponentToCpc(component, llmCall) {
  // Use capability from identify-capability pipeline, fall back to component name
  const capability = component.capability || component.name || '';
  const componentName = component.name || '';
  const context = component.description || component.context || '';

  // Path 1: LLM-assisted mapping
  if (typeof llmCall === 'function') {
    try {
      const codes = await llmMapToCpc(capability, componentName, context, llmCall);
      if (codes.length > 0) {
        return codes;
      }
      // LLM returned no valid codes — fall through to hardcoded
    } catch {
      // LLM failed — fall through to hardcoded
    }
  }

  // Path 2: Hardcoded fallback
  // Try capability first, then component name
  const fallback = lookupFallback(capability) || lookupFallback(componentName);
  if (fallback) {
    return fallback.codes;
  }

  // Path 3: No mapping found
  return [];
}
