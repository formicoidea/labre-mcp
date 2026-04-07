// CPC Mapper: translate Wardley component capabilities into CPC codes
// via progressive discovery through the CPC hierarchy.
//
// Resolution strategy:
//   1. LLM identifies the CPC section + class (e.g., "G06")
//   2. Cache/BigQuery provides real subclasses → LLM picks (e.g., "G06F")
//   3. Cache/BigQuery provides real groups → LLM picks (e.g., "G06F9/")
//   4. Optionally: cache provides subgroups → LLM picks (e.g., "G06F9/455")
//
// At each level, the LLM chooses from REAL codes that exist in the patent
// database — no guessing in the void.
//
// Fallback: if BigQuery/cache is unavailable, the LLM returns a 4-char code
// from its training knowledge (graceful degradation).
//
// Pipeline integration:
//   cpc-evolution-strategy.mjs calls mapCapabilityToCPC(capability, options)
//   which returns 1-5 CPC codes at the most specific level discovered.

import { createLLMCall } from '../llm-call.mjs';

// ─── CPC code validation ───────────────────────────────────────────────────

/**
 * Regex for a valid CPC code at any level of the hierarchy:
 *   - Subclass:  G06F           (4 chars)
 *   - Group:     G06F9/         (subclass + digits + slash)
 *   - Subgroup:  G06F9/455      (group + digits)
 *   - Full:      G06F9/45558    (group + longer digits)
 */
export const CPC_CODE_REGEX = /^[A-H]\d{2}[A-Z](\d+\/([\d]+)?)?$/;

/**
 * Validate a CPC code string at any hierarchy level.
 * @param {string} code
 * @returns {boolean}
 */
export function isValidCpcCode(code) {
  return typeof code === 'string' && CPC_CODE_REGEX.test(code);
}

// ─── LLM prompt templates ──────────────────────────────────────────────────

const PROMPT_PICK_CLASS = `You are a patent classification expert. Given a technology capability, identify the most relevant CPC class code (3 characters: section letter A-H + 2 digits).

CPC sections:
  A = Human Necessities (medical, agriculture, food)
  B = Operations & Transport (manufacturing, vehicles, 3D printing)
  C = Chemistry & Metallurgy (materials, biotech, pharma)
  D = Textiles & Paper
  E = Fixed Constructions (buildings, mining)
  F = Mechanical Engineering (engines, heating, weapons)
  G = Physics (computing G06, measuring G01, optics G02)
  H = Electricity (telecom H04, semiconductors H01, power H02)

Common classes:
  G06 = Computing (software, AI, data processing, databases)
  H04 = Electric communication (networks, wireless, protocols)
  H01 = Basic electric elements (semiconductors, batteries)
  G01 = Measuring & testing (sensors, instruments)
  B60 = Vehicles (autonomous driving)
  A61 = Medical & veterinary science

Capability: {{capability}}

Return ONLY the 3-character class code (e.g., G06). Nothing else.`;

const PROMPT_PICK_FROM_LIST = `You are a patent classification expert. Given a technology capability, select the most relevant CPC code(s) from the list below.

Capability: {{capability}}

Available codes:
{{codes_list}}

Select 1-3 most relevant codes. Return ONLY the codes, one per line. Nothing else.`;

// ─── Internal LLM helpers ───────────────────────────────────────────────────

/**
 * Ask LLM to identify the CPC class (3 chars) for a capability.
 * @param {string} capability
 * @param {function} llmCall
 * @returns {Promise<string|null>} 3-char class code or null
 */
async function llmPickClass(capability, llmCall) {
  const prompt = PROMPT_PICK_CLASS.replace('{{capability}}', capability);
  const response = await llmCall(prompt);

  // Extract 3-char class code (letter + 2 digits)
  const match = response.match(/\b([A-H]\d{2})\b/);
  return match ? match[1] : null;
}

/**
 * Ask LLM to pick from a list of real CPC codes.
 * @param {string} capability
 * @param {Array<{code: string, cnt: number}>} codeEntries - Available codes with patent counts
 * @param {function} llmCall
 * @returns {Promise<string[]>} Selected codes (1-3)
 */
async function llmPickFromList(capability, codeEntries, llmCall) {
  if (codeEntries.length === 0) return [];
  if (codeEntries.length === 1) return [codeEntries[0].code];

  // Format codes with patent counts for context
  const codesList = codeEntries
    .map(e => `${e.code} (${formatCount(e.cnt)} patents)`)
    .join('\n');

  const prompt = PROMPT_PICK_FROM_LIST
    .replace('{{capability}}', capability)
    .replace('{{codes_list}}', codesList);

  const response = await llmCall(prompt);

  // Extract codes that match entries in our list
  const availableCodes = new Set(codeEntries.map(e => e.code));
  const selected = response
    .split(/[\s,;\n]+/)
    .map(s => s.trim())
    .filter(s => availableCodes.has(s));

  // Deduplicate, cap at 3
  return [...new Set(selected)].slice(0, 3);
}

/**
 * Format a number for display (e.g., 8780599 → "8.8M").
 * @param {number} n
 * @returns {string}
 */
function formatCount(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

// ─── Standalone LLM fallback (no cache) ─────────────────────────────────────

const LLM_FALLBACK_PROMPT = `You are a patent classification expert. Given a technology capability, identify the 1-3 most relevant CPC sub-class codes (4 characters: section letter A-H + 2 digits + 1 letter).

Capability: {{capability}}

Return ONLY the codes, one per line. Nothing else.`;

/**
 * Fallback: ask LLM to produce CPC codes without progressive discovery.
 * Used when BigQuery/cache is unavailable.
 * @param {string} capability
 * @param {function} llmCall
 * @returns {Promise<string[]>} Array of 4-char CPC codes
 */
async function llmFallbackMapping(capability, llmCall) {
  const prompt = LLM_FALLBACK_PROMPT.replace('{{capability}}', capability);
  const response = await llmCall(prompt);

  const codes = response
    .split(/[\s,;\n]+/)
    .map(s => s.trim().toUpperCase())
    .filter(s => /^[A-H]\d{2}[A-Z]$/.test(s));

  return [...new Set(codes)].slice(0, 5);
}

// ─── Progressive discovery engine ───────────────────────────────────────────

/**
 * Progressively discover CPC codes through the hierarchy.
 *
 * Flow:
 *   1. LLM picks class (3 chars)
 *   2. Cache → subclasses → LLM picks (4 chars)
 *   3. Cache → groups → LLM picks (e.g., "G06F9/")
 *   4. Cache → subgroups → LLM picks (e.g., "G06F9/455")
 *
 * Stops descending when:
 *   - No children at a level (leaf reached)
 *   - Cache/BigQuery unavailable (returns best level found)
 *
 * @param {string} capability - Technology capability text
 * @param {function} llmCall - LLM call function
 * @param {import('./cpc-taxonomy-cache.mjs').CpcTaxonomyCache} taxonomyCache
 * @returns {Promise<string[]>} 1-5 CPC codes at the deepest level discovered
 */
async function progressiveDiscovery(capability, llmCall, taxonomyCache) {
  // Step 1: LLM identifies the class
  const classCode = await llmPickClass(capability, llmCall);
  if (!classCode) return [];

  // Step 2: Get real subclasses from cache/BigQuery
  const subclasses = await taxonomyCache.getSubclasses(classCode);
  if (subclasses.length === 0) {
    // No data at this level — can't descend further
    return [];
  }

  const selectedSubclasses = await llmPickFromList(capability, subclasses, llmCall);
  if (selectedSubclasses.length === 0) return [];

  // Step 3: For each selected subclass, get groups
  const allGroups = [];
  for (const sc of selectedSubclasses.slice(0, 2)) { // Limit to 2 subclasses to control LLM calls
    const groups = await taxonomyCache.getGroups(sc);
    if (groups.length > 0) {
      allGroups.push(...groups.map(g => ({ ...g, parent: sc })));
    }
  }

  if (allGroups.length === 0) {
    // No groups found — return at subclass level
    return selectedSubclasses;
  }

  const selectedGroups = await llmPickFromList(capability, allGroups, llmCall);
  if (selectedGroups.length === 0) return selectedSubclasses;

  // Step 4: For each selected group, get subgroups
  const allSubgroups = [];
  for (const grp of selectedGroups.slice(0, 2)) { // Limit to 2 groups
    const subgroups = await taxonomyCache.getSubgroups(grp);
    if (subgroups.length > 0) {
      allSubgroups.push(...subgroups);
    }
  }

  if (allSubgroups.length === 0) {
    // No subgroups — return at group level
    return selectedGroups;
  }

  const selectedSubgroups = await llmPickFromList(capability, allSubgroups, llmCall);
  if (selectedSubgroups.length === 0) return selectedGroups;

  return selectedSubgroups;
}

// ─── Main public API ────────────────────────────────────────────────────────

/**
 * Default CPC code returned when all resolution paths fail.
 * @type {string[]}
 */
const ULTIMATE_DEFAULT_CODES = ['G06F'];

/**
 * Map a capability string to 1-5 CPC codes via progressive discovery.
 *
 * Resolution cascade:
 *   1. Progressive discovery (LLM + cache/BigQuery hierarchy)
 *   2. LLM fallback (no cache — LLM guesses from training knowledge)
 *   3. Ultimate default: ['G06F']
 *
 * **Return contract:** Always returns an array with 1-5 elements.
 * Never throws, never returns empty.
 *
 * @param {string} capability - Technology capability or component description
 * @param {Object} [options]
 * @param {function} [options.llmCall] - Injected LLM call function
 * @param {import('./cpc-taxonomy-cache.mjs').CpcTaxonomyCache} [options.taxonomyCache] - CPC cache
 * @returns {Promise<string[]>} Array of 1-5 valid CPC codes
 */
export async function mapCapabilityToCPC(capability, options = {}) {
  const cap = (typeof capability === 'string' ? capability : '').trim();
  if (!cap) return [...ULTIMATE_DEFAULT_CODES];

  // Resolve LLM call function
  const llmCall = typeof options.llmCall === 'function'
    ? options.llmCall
    : createLLMCall({ effort: 'low', maxBudgetUsd: 0.05 });

  // Path 1: Progressive discovery with taxonomy cache
  if (options.taxonomyCache) {
    try {
      const codes = await progressiveDiscovery(cap, llmCall, options.taxonomyCache);
      if (codes.length > 0) {
        return codes.slice(0, 5);
      }
    } catch {
      // Progressive discovery failed — fall through
    }
  }

  // Path 2: LLM fallback (no cache, returns 4-char codes)
  try {
    const codes = await llmFallbackMapping(cap, llmCall);
    if (codes.length > 0) {
      return codes.slice(0, 5);
    }
  } catch {
    // LLM failed entirely
  }

  // Path 3: Ultimate default
  return [...ULTIMATE_DEFAULT_CODES];
}

/**
 * Map a component to CPC codes.
 *
 * Uses component.capability (from identify-capability pipeline) if available,
 * otherwise falls back to component.name.
 *
 * @param {import('../strategies/base-strategy.mjs').ComponentInput} component
 * @param {function} [llmCall] - Optional LLM call function
 * @param {Object} [options]
 * @param {import('./cpc-taxonomy-cache.mjs').CpcTaxonomyCache} [options.taxonomyCache]
 * @returns {Promise<string[]>} Array of valid CPC codes
 */
export async function mapComponentToCpc(component, llmCall, options = {}) {
  const capability = component.capability || component.name || '';
  return mapCapabilityToCPC(capability, {
    llmCall,
    taxonomyCache: options.taxonomyCache,
  });
}

// ─── Exports for testing ────────────────────────────────────────────────────

export {
  llmPickClass,
  llmPickFromList,
  llmFallbackMapping,
  progressiveDiscovery,
  formatCount,
  ULTIMATE_DEFAULT_CODES,
};
