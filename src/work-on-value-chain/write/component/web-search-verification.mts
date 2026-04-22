// Web search verification for solution vs capability classification
//
// When naming convention heuristics don't reach the 90% confidence threshold,
// this module verifies whether a component is a known product/solution or an
// abstract capability by searching the web for evidence.
//
// Evidence markers for SOLUTIONS:
//   - Official website or product page
//   - Wikipedia article describing software/platform/product/service
//   - Vendor/company association (e.g. "by Google", "developed by Microsoft")
//   - Pricing, licensing, or subscription information
//   - GitHub repository with releases/versions
//   - Download/install instructions for a specific tool
//
// Evidence markers for CAPABILITIES:
//   - Multiple different products/solutions implement it
//   - Described as a concept, methodology, practice, or discipline
//   - Wikipedia categorizes it as a computing concept or technique
//   - No single vendor dominates search results
//   - Generic "what is" results without pointing to a specific product
//
// Usage:
//   import { verifyViaWebSearch, createWebSearchCall } from './web-search-verification.mjs';
//
//   // With default Agent SDK web search backend
//   const webSearch = createWebSearchCall();
//   const result = await verifyViaWebSearch('Kubernetes', { webSearchCall: webSearch });
//   // → { classification: 'solution', confidence: 0.94, evidence: [...], references: [...] }
//
//   // With custom/mock web search function (for testing)
//   const result = await verifyViaWebSearch('CRM', { webSearchCall: mockSearch });
//   // → { classification: 'capability', confidence: 0.88, evidence: [...], references: [...] }

import { query } from '@anthropic-ai/claude-agent-sdk';
import { logDebug, logWarning } from '../../../lib/mcp-notifications.mjs';
import { classifyAndLogLLMError } from '../../../lib/llm/llm-error-handler.mjs';
import type { WebSearchVerificationResult, WebSearchEvidence, WebSearchReference } from '../../../types/routing.mjs';
import { toErrorMessage, errorCode } from '../../../lib/errors.mjs';
import { parseKeyValueBlock, parseDelimitedBlock } from '../../../lib/prompts/parsers.mjs';
import { getPrompt } from '../../../lib/prompts/registry.mjs';
import { getCurrentCollector } from '../../../lib/degradation/index.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL = 'web-search-verification';

/** Max retries for web search backend */
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1500;

/** Retryable error patterns (network-level issues) */
const RETRYABLE_PATTERNS = [
  'timeout', 'rate', 'overloaded', 'temporarily', 'network',
  'concurrency', 'empty response', 'unknown error',
];

function isRetryableError(err: unknown): boolean {
  const msg = String(toErrorMessage(err) || err).toLowerCase();
  return RETRYABLE_PATTERNS.some((p: string) => msg.includes(p));
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// ─── Result Types ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WebSearchEvidence
 * @property {string} type         - Evidence type: 'product-page' | 'wikipedia' | 'vendor-association' | 'pricing' | 'repository' | 'concept-article' | 'multi-implementation' | 'generic'
 * @property {string} description  - Human-readable description of the evidence
 * @property {string} [source]     - Source URL or domain
 * @property {'solution'|'capability'} supports - Which classification this evidence supports
 */

/**
 * @typedef {Object} WebSearchReference
 * @property {string} title  - Page/article title
 * @property {string} [url]  - Source URL
 * @property {string} [snippet] - Relevant snippet or excerpt
 */

/**
 * @typedef {Object} WebSearchVerificationResult
 * @property {'solution'|'capability'} classification - Component classification
 * @property {number}  confidence   - Confidence score (0–1)
 * @property {string}  method       - Always 'web-search'
 * @property {string}  reasoning    - Human-readable explanation
 * @property {boolean} isSolution   - Convenience flag
 * @property {WebSearchEvidence[]}  evidence   - Structured evidence items
 * @property {WebSearchReference[]} references - Source references found
 */

// ─── Web Search Prompt ───────────────────────────────────────────────────────

/**
 * Prompt template for web search-based verification.
 *
 * The LLM is instructed to:
 *   1. Search the web for information about the component
 *   2. Analyze results for product/solution vs capability evidence
 *   3. Return structured classification with references
 */
// Prompt text lives in prompts/web-search-verification.md. Resolved via getPrompt('web-search-verification').

// ─── Response Parsing ─────────────────────────────────────────────────────────

/**
 * Parse the web search verification response from the LLM.
 *
 * Extracts classification, confidence, reasoning, evidence, and references
 * from the structured response format. Falls back to keyword-based extraction
 * if the response doesn't match the expected format.
 *
 * @param {string} text - Raw LLM response text
 * @param {string} name - Component name (for fallback messages)
 * @returns {WebSearchVerificationResult}
 */
export function parseWebSearchResponse(text: string, name: string) {
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return createFallbackResult(name, 'Empty web search response');
  }

  // ── Parse classification line ────────────────────────────────────────
  const raw = parseKeyValueBlock(text, ['classification', 'confidence', 'reasoning']);
  const classValue = raw.classification?.toLowerCase().match(/^(solution|capability)\b/)?.[1];

  // ── Parse evidence block ─────────────────────────────────────────────
  const evidence = parseEvidenceBlock(text);

  // ── Parse references block ───────────────────────────────────────────
  const references = parseReferencesBlock(text);

  // ── Build result ─────────────────────────────────────────────────────
  if (classValue) {
    const classification = classValue === 'solution' ? 'solution' : 'capability';
    const rawConf = raw.confidence !== undefined ? parseFloat(raw.confidence) : 0.70;
    const confidence = Math.round(Math.max(0, Math.min(1, rawConf)) * 100) / 100;
    const reasoning = raw.reasoning ?? `Web search classified "${name}" as ${classification}`;

    return {
      classification,
      confidence,
      method: 'web-search',
      reasoning,
      isSolution: classification === 'solution',
      evidence,
      references,
    };
  }

  // ── Fallback: keyword-based classification ───────────────────────────
  return inferFromKeywords(text, name, evidence, references);
}

/**
 * Parse the EVIDENCE_START...EVIDENCE_END block from LLM response.
 *
 * @param {string} text - Full LLM response
 * @returns {WebSearchEvidence[]}
 */
function parseEvidenceBlock(text: string) {
  const evidence: WebSearchEvidence[] = [];
  const block = parseDelimitedBlock(text, 'EVIDENCE_START', 'EVIDENCE_END');

  if (!block) return evidence;

  const lines = block.split('\n').filter(l => l.trim().length > 0);

  for (const line of lines) {
    const fields: Record<string, string> = {};
    // Parse pipe-separated key=value pairs
    const parts = line.split('|');
    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        const key = part.substring(0, eqIdx).trim().toLowerCase();
        const value = part.substring(eqIdx + 1).trim();
        fields[key] = value;
      }
    }

    if (fields.type && fields.description) {
      evidence.push({
        type: normalizeEvidenceType(fields.type),
        description: fields.description,
        source: fields.source || undefined,
        supports: (fields.supports || 'solution').toLowerCase() === 'capability'
          ? 'capability'
          : 'solution',
      });
    }
  }

  return evidence;
}

/**
 * Parse the REFERENCES_START...REFERENCES_END block from LLM response.
 *
 * @param {string} text - Full LLM response
 * @returns {WebSearchReference[]}
 */
function parseReferencesBlock(text: string) {
  const references: WebSearchReference[] = [];
  const block = parseDelimitedBlock(text, 'REFERENCES_START', 'REFERENCES_END');

  if (!block) return references;

  const lines = block.split('\n').filter(l => l.trim().length > 0);

  for (const line of lines) {
    const fields: Record<string, string> = {};
    const parts = line.split('|');
    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) {
        const key = part.substring(0, eqIdx).trim().toLowerCase();
        const value = part.substring(eqIdx + 1).trim();
        fields[key] = value;
      }
    }

    if (fields.title) {
      references.push({
        title: fields.title,
        url: fields.url || '',
        snippet: fields.snippet || undefined,
      });
    }
  }

  return references;
}

/**
 * Normalize evidence type strings to a known set.
 * @param {string} raw - Raw evidence type from LLM
 * @returns {string} Normalized evidence type
 */
function normalizeEvidenceType(raw: string | null | undefined): string {
  const normalized = (raw || '').toLowerCase().replace(/[\s_]+/g, '-').trim();
  const validTypes = [
    'product-page', 'wikipedia', 'vendor-association', 'pricing',
    'repository', 'concept-article', 'multi-implementation', 'generic',
  ];
  return validTypes.includes(normalized) ? normalized : 'generic';
}

/**
 * Infer classification from response keywords when structured parsing fails.
 *
 * @param {string} text     - LLM response text
 * @param {string} name     - Component name
 * @param {WebSearchEvidence[]} evidence - Any evidence parsed
 * @param {WebSearchReference[]} references - Any references parsed
 * @returns {WebSearchVerificationResult}
 */
function inferFromKeywords(text: string, name: string, evidence: WebSearchEvidence[], references: WebSearchReference[]): WebSearchVerificationResult {
  const lower = text.toLowerCase();

  // Count solution vs capability evidence keywords
  const solutionKeywords = [
    'official website', 'product page', 'developed by', 'created by',
    'maintained by', 'vendor', 'pricing', 'license', 'download',
    'install', 'version', 'release', 'commercial', 'open.?source project',
    'software', 'platform', 'tool', 'framework', 'service',
  ];
  const capabilityKeywords = [
    'concept', 'methodology', 'practice', 'discipline', 'technique',
    'abstract', 'general.?purpose', 'category', 'type of', 'class of',
    'multiple implementations', 'various products', 'umbrella term',
    'capability', 'activity', 'process',
  ];

  let solutionScore = 0;
  let capabilityScore = 0;

  for (const kw of solutionKeywords) {
    if (new RegExp(kw, 'i').test(lower)) solutionScore++;
  }
  for (const kw of capabilityKeywords) {
    if (new RegExp(kw, 'i').test(lower)) capabilityScore++;
  }

  // Also factor in evidence supports
  for (const ev of evidence) {
    if (ev.supports === 'solution') solutionScore += 2;
    if (ev.supports === 'capability') capabilityScore += 2;
  }

  const total = solutionScore + capabilityScore;
  if (total === 0) {
    return createFallbackResult(name, 'No clear evidence from web search');
  }

  const isSolution = solutionScore > capabilityScore;
  const dominance = Math.max(solutionScore, capabilityScore) / total;
  const confidence = Math.round(Math.min(0.85, 0.50 + dominance * 0.35) * 100) / 100;

  return {
    classification: isSolution ? 'solution' : 'capability',
    confidence,
    method: 'web-search',
    reasoning: `Web search keyword analysis: ${isSolution ? 'solution' : 'capability'} evidence dominates (${Math.max(solutionScore, capabilityScore)}/${total} keywords matched)`,
    isSolution,
    evidence,
    references,
  };
}

/**
 * Create a fallback result when web search response is unparseable.
 *
 * @param {string} name   - Component name
 * @param {string} reason - Why the fallback was triggered
 * @returns {WebSearchVerificationResult}
 */
function createFallbackResult(name: string, reason: string): WebSearchVerificationResult {
  return {
    classification: 'capability',
    confidence: 0.40,
    method: 'web-search',
    reasoning: `Could not verify "${name}" via web search: ${reason} — defaulting to capability`,
    isSolution: false,
    evidence: [],
    references: [],
  };
}

// ─── Web Search Backend ───────────────────────────────────────────────────────

/**
 * Create a web search call function backed by the Claude Agent SDK.
 *
 * Uses `query()` with WebSearch and WebFetch tools enabled so the LLM can
 * perform real web searches to gather evidence about a component.
 *
 * @param {Object} [config={}]
 * @param {string} [config.model='claude-sonnet-4-6'] - Model to use
 * @param {number} [config.maxTurns=3]                 - Max tool-use turns (search + analyze)
 * @returns {function(string, Object?): Promise<string>}
 */
// any: config bag accepts diverse Claude Agent SDK options (model, effort, maxTurns, ...)
export function createWebSearchCall(config: any = {}) {
  const {
    model = 'claude-sonnet-4-6',
    maxTurns = 3,
  } = config;

  return async function webSearchCall(prompt: string): Promise<string> {
    // Prevent nested session detection
    if (process.env.CLAUDECODE) {
      delete process.env.CLAUDECODE;
    }

    // any: Claude Agent SDK options bag with diverse fields
    const options: any = {
      model,
      maxTurns,
      effort: 'high',
      persistSession: false,
      // Allow WebSearch and WebFetch; disallow filesystem/code tools
      disallowedTools: ['Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Read', 'Agent', 'NotebookEdit'],
    };

    const errorContext = { logger: TOOL, model };

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        let resultText = '';
        for await (const message of query({ prompt, options } as Parameters<typeof query>[0])) {
          const msg = message as any;  // any: Claude Agent SDK streaming message (untyped union)
          if (msg.type === 'result') {
            if (msg.subtype === 'success') {
              resultText = msg.result || '';
            } else {
              const errors = msg.errors || [];
              throw new Error(`Web search call failed: ${errors.join(', ') || 'unknown error'}`);
            }
          }
        }
        if (!resultText) {
          throw new Error('Web search call returned empty response');
        }
        return resultText;
      } catch (err) {
        lastError = err;
        if (isRetryableError(err) && attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * (2 ** attempt);
          logDebug(TOOL, `Retrying web search (attempt ${attempt + 2}/${MAX_RETRIES}) after ${backoff}ms...`);
          await sleep(backoff);
          continue;
        }
        classifyAndLogLLMError(err, errorContext);
        throw err;
      }
    }
    classifyAndLogLLMError(lastError, errorContext);
    throw lastError;
  };
}

// ─── Main Verification Function ──────────────────────────────────────────────

/**
 * Verify whether a component is a known product/solution or an abstract
 * capability using web search evidence.
 *
 * This function is designed as the fallback tier in the detection pipeline:
 *   Tier 1: Naming convention heuristics (fast, no cost)
 *   Tier 2: LLM semantic classification (moderate cost)
 *   Tier 3: Web search verification (higher cost, higher accuracy) ← this
 *
 * @param {string} name - Component name to verify
 * @param {Object} [options={}]
 * @param {function(string): Promise<string>} [options.webSearchCall]
 *   Custom web search function. If not provided, creates one via
 *   createWebSearchCall(). Accepts a prompt and returns raw text response.
 * @param {string} [options.context] - Additional context about the component
 * @returns {Promise<WebSearchVerificationResult>}
 */
export async function verifyViaWebSearch(name: string, options: { description?: string; context?: string; webSearchCall?: any; timeoutMs?: number } = {}): Promise<WebSearchVerificationResult> {
  const trimmed = (name || '').trim();

  if (!trimmed) {
    return createFallbackResult(name, 'Empty component name');
  }

  // Resolve web search backend
  const webSearchCall = options.webSearchCall || createWebSearchCall();

  if (typeof webSearchCall !== 'function') {
    throw new Error('verifyViaWebSearch requires a webSearchCall function');
  }

  // Build the search prompt
  const contextLine = options.context
    ? `Additional context: ${options.context}`
    : 'Additional context: (none provided)';

  const p = getPrompt('web-search-verification');
  const prompt = p.build({ name: trimmed, context_line: contextLine });

  logDebug(TOOL, `Starting web search verification for "${trimmed}"...`);

  try {
    const response = await webSearchCall(prompt);
    const result = p.parse(response, trimmed);

    logDebug(TOOL,
      `Web search result for "${trimmed}": ${result.classification} ` +
      `(confidence=${result.confidence}, evidence=${result.evidence?.length ?? 0}, ` +
      `references=${result.references?.length ?? 0})`);

    return result;
  } catch (err) {
    logWarning(TOOL, `Web search verification failed for "${trimmed}": ${toErrorMessage(err)}`);

    // Surface the failure on the ambient degradation collector so the MCP
    // result reports degraded:true with a 'web-search' source. Falling
    // back to 'capability' with low confidence is the existing behavior;
    // we just stop hiding it.
    const collector = getCurrentCollector();
    if (collector) {
      collector.recordError('web-search', err, { recoverable: true });
    }

    return {
      classification: 'capability',
      confidence: 0.35,
      method: 'web-search',
      reasoning: `Web search verification failed for "${trimmed}": ${toErrorMessage(err)} — defaulting to capability`,
      isSolution: false,
      evidence: [],
      references: [],
      error: toErrorMessage(err),
    };
  }
}

// ─── Integration Helper ──────────────────────────────────────────────────────

/**
 * Combine web search verification with a prior naming/LLM classification.
 *
 * Used by the detection pipeline to merge evidence from multiple tiers.
 * When web search agrees with the prior result, confidence is boosted.
 * When they disagree, the web search result takes priority (it has
 * stronger evidence) but confidence is reduced.
 *
 * @param {Object} priorResult   - Result from naming or LLM tier
 * @param {WebSearchVerificationResult} webResult - Web search result
 * @returns {WebSearchVerificationResult} Combined result
 */
// any: priorResult/webResult are heterogeneous; combination merges loose fields
export function combineWithPriorResult(priorResult: any, webResult: WebSearchVerificationResult): any {
  if (!priorResult || !webResult) {
    return webResult || priorResult || createFallbackResult('unknown', 'No results to combine');
  }

  const priorClass = priorResult.classification || priorResult.type;
  const webClass = webResult.classification;

  if (priorClass === webClass) {
    // Agreement: boost confidence (average + agreement bonus)
    // Bonus of 0.10 matches the detect-solution.mjs agreement pattern
    const boosted = Math.round(
      Math.min(0.98, (priorResult.confidence + webResult.confidence) / 2 + 0.10) * 100
    ) / 100;

    return {
      ...webResult,
      confidence: boosted,
      method: `${priorResult.method || 'prior'}+web-search`,
      reasoning: `${webResult.reasoning} (agrees with prior ${priorResult.method || 'detection'}: ${priorResult.reasoning || priorClass})`,
    };
  }

  // Disagreement: trust web search (has real evidence), but lower confidence
  // Penalty of 0.10 matches the detect-solution.mjs disagreement pattern
  const reduced = Math.round(
    Math.max(0.45, webResult.confidence - 0.10) * 100
  ) / 100;

  return {
    ...webResult,
    confidence: reduced,
    method: `${priorResult.method || 'prior'}+web-search`,
    reasoning: `Web search overrides prior ${priorResult.method || 'detection'}: ${webResult.reasoning} (prior said: ${priorClass})`,
  };
}

// ─── Exports for Testing ─────────────────────────────────────────────────────

