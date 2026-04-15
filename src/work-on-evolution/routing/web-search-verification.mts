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
import { logDebug, logWarning } from '../../lib/mcp-notifications.mjs';
import { classifyAndLogLLMError } from '../../lib/llm/llm-error-handler.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

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
const WEB_SEARCH_VERIFICATION_PROMPT = `You are verifying whether a component used in Wardley Mapping is a concrete SOLUTION (product/platform/service/framework) or an abstract CAPABILITY (activity/practice/concept).

Component to verify: "{{name}}"
{{contextLine}}

STEP 1: Search the web for "{{name}}" to find:
- Official product/company website
- Wikipedia article
- GitHub repository or documentation
- Pricing/licensing pages
- Articles describing what it is

STEP 2: Analyze the search results and classify:
- SOLUTION: Has a specific vendor/creator, official website, versions/releases, is a named product/platform/tool
- CAPABILITY: Is a general concept, practice, or activity that multiple products can implement

STEP 3: Report your findings in EXACTLY this format (one section per line):

classification=SOLUTION or CAPABILITY
confidence=X.XX (0 to 1, based on strength of web evidence)
reasoning=<one sentence explaining classification based on web findings>
EVIDENCE_START
type=<evidence-type>|description=<what you found>|source=<url-or-domain>|supports=<solution-or-capability>
type=<evidence-type>|description=<what you found>|source=<url-or-domain>|supports=<solution-or-capability>
EVIDENCE_END
REFERENCES_START
title=<page-title>|url=<url>|snippet=<relevant-excerpt>
title=<page-title>|url=<url>|snippet=<relevant-excerpt>
REFERENCES_END

Evidence types: product-page, wikipedia, vendor-association, pricing, repository, concept-article, multi-implementation, generic
Keep evidence items to 2-5 most relevant findings.
Keep references to 2-4 most relevant sources.`;

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
  const classMatch = text.match(/^classification\s*=\s*(solution|capability)/mi);
  const confMatch = text.match(/^confidence\s*=\s*(-?[\d.]+)/mi);
  const reasonMatch = text.match(/^reasoning\s*=\s*(.+)/mi);

  // ── Parse evidence block ─────────────────────────────────────────────
  const evidence = parseEvidenceBlock(text);

  // ── Parse references block ───────────────────────────────────────────
  const references = parseReferencesBlock(text);

  // ── Build result ─────────────────────────────────────────────────────
  if (classMatch) {
    const classification = classMatch[1].toLowerCase() === 'solution' ? 'solution' : 'capability';
    const rawConf = confMatch ? parseFloat(confMatch[1]) : 0.70;
    const confidence = Math.round(Math.max(0, Math.min(1, rawConf)) * 100) / 100;
    const reasoning = reasonMatch
      ? reasonMatch[1].trim()
      : `Web search classified "${name}" as ${classification}`;

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
  const evidence: any[] = [];
  const evidenceMatch = text.match(/EVIDENCE_START\s*\n([\s\S]*?)\nEVIDENCE_END/i);

  if (!evidenceMatch) return evidence;

  const lines = evidenceMatch[1].split('\n').filter(l => l.trim().length > 0);

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
  const references: any[] = [];
  const refMatch = text.match(/REFERENCES_START\s*\n([\s\S]*?)\nREFERENCES_END/i);

  if (!refMatch) return references;

  const lines = refMatch[1].split('\n').filter(l => l.trim().length > 0);

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
        url: fields.url || undefined,
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
function inferFromKeywords(text: string, name: string, evidence: any[], references: any[]): any {
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
function createFallbackResult(name: string, reason: string): any {
  return {
    classification: 'capability',
    confidence: 0.40,
    method: 'web-search',
    reasoning: `Could not verify "${name}" via web search: ${reason} — defaulting to capability`,
    isSolution: false,
    evidence: [] as any[],
    references: [] as any[],
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
 * @param {number} [config.maxBudgetUsd=0.08]         - Budget limit per call
 * @param {number} [config.maxTurns=3]                 - Max tool-use turns (search + analyze)
 * @returns {function(string, Object?): Promise<string>}
 */
export function createWebSearchCall(config: any = {}) {
  const {
    model = 'claude-sonnet-4-6',
    maxBudgetUsd = 0.08,
    maxTurns = 3,
  } = config;

  return async function webSearchCall(prompt: string): Promise<string> {
    // Prevent nested session detection
    if (process.env.CLAUDECODE) {
      delete process.env.CLAUDECODE;
    }

    const options: any = {
      model,
      maxTurns,
      effort: 'high',
      maxBudgetUsd,
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
          const msg = message as any;
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
export async function verifyViaWebSearch(name: string, options: any = {}) {
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

  const prompt = WEB_SEARCH_VERIFICATION_PROMPT
    .replace(/\{\{name\}\}/g, trimmed)
    .replace('{{contextLine}}', contextLine);

  logDebug(TOOL, `Starting web search verification for "${trimmed}"...`);

  try {
    const response = await webSearchCall(prompt);
    const result = parseWebSearchResponse(response, trimmed);

    logDebug(TOOL,
      `Web search result for "${trimmed}": ${result.classification} ` +
      `(confidence=${result.confidence}, evidence=${result.evidence.length}, ` +
      `references=${result.references.length})`);

    return result;
  } catch (err) {
    logWarning(TOOL, `Web search verification failed for "${trimmed}": ${toErrorMessage(err)}`);

    return {
      classification: 'capability',
      confidence: 0.35,
      method: 'web-search',
      reasoning: `Web search verification failed for "${trimmed}": ${toErrorMessage(err)} — defaulting to capability`,
      isSolution: false,
      evidence: [] as any[],
      references: [] as any[],
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
export function combineWithPriorResult(priorResult: any, webResult: any) {
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

export { WEB_SEARCH_VERIFICATION_PROMPT };

// ─── Self-test ───────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== web-search-verification.mjs self-test ===\n');

  // ── Test 1: Parse well-formatted solution response ─────────────────
  console.log('--- Test 1: Parse solution response ---');
  const solutionResponse = `classification=SOLUTION
confidence=0.94
reasoning=Kubernetes is a specific container orchestration platform originally developed by Google and now maintained by the CNCF.
EVIDENCE_START
type=product-page|description=Official Kubernetes website at kubernetes.io|source=kubernetes.io|supports=solution
type=wikipedia|description=Wikipedia describes Kubernetes as an open-source container orchestration system|source=en.wikipedia.org/wiki/Kubernetes|supports=solution
type=repository|description=GitHub repository kubernetes/kubernetes with 100k+ stars|source=github.com/kubernetes/kubernetes|supports=solution
EVIDENCE_END
REFERENCES_START
title=Kubernetes - Production-Grade Container Orchestration|url=https://kubernetes.io|snippet=Kubernetes is an open-source system for automating deployment, scaling, and management of containerized applications.
title=Kubernetes - Wikipedia|url=https://en.wikipedia.org/wiki/Kubernetes|snippet=Kubernetes is an open-source container orchestration system for automating software deployment, scaling, and management. Originally designed by Google.
REFERENCES_END`;

  const r1 = parseWebSearchResponse(solutionResponse, 'Kubernetes');
  console.assert(r1.classification === 'solution', `Expected solution, got ${r1.classification}`);
  console.assert(r1.confidence === 0.94, `Expected 0.94, got ${r1.confidence}`);
  console.assert(r1.isSolution === true, 'Expected isSolution=true');
  console.assert(r1.method === 'web-search', `Expected web-search, got ${r1.method}`);
  console.assert(r1.evidence.length === 3, `Expected 3 evidence items, got ${r1.evidence.length}`);
  console.assert(r1.references.length === 2, `Expected 2 references, got ${r1.references.length}`);
  console.assert(r1.evidence[0].type === 'product-page', `Expected product-page, got ${r1.evidence[0].type}`);
  console.assert(r1.evidence[0].supports === 'solution', `Expected solution, got ${r1.evidence[0].supports}`);
  console.log('  \u2713 Solution response parsed correctly');

  // ── Test 2: Parse well-formatted capability response ───────────────
  console.log('\n--- Test 2: Parse capability response ---');
  const capabilityResponse = `classification=CAPABILITY
confidence=0.88
reasoning=Container orchestration is an abstract concept describing the automated management of containerized applications, implemented by multiple tools.
EVIDENCE_START
type=concept-article|description=Wikipedia describes container orchestration as a general computing concept|source=en.wikipedia.org/wiki/Container_orchestration|supports=capability
type=multi-implementation|description=Multiple products implement this: Kubernetes, Docker Swarm, Nomad, Amazon ECS|source=various|supports=capability
EVIDENCE_END
REFERENCES_START
title=Container orchestration - Wikipedia|url=https://en.wikipedia.org/wiki/Container_orchestration|snippet=Container orchestration is the automatic process of managing or scheduling the work of individual containers.
title=What is Container Orchestration? - Red Hat|url=https://www.redhat.com/en/topics/containers/what-is-container-orchestration|snippet=Container orchestration automates the provisioning, deployment, networking, scaling...
REFERENCES_END`;

  const r2 = parseWebSearchResponse(capabilityResponse, 'container orchestration');
  console.assert(r2.classification === 'capability', `Expected capability, got ${r2.classification}`);
  console.assert(r2.confidence === 0.88, `Expected 0.88, got ${r2.confidence}`);
  console.assert(r2.isSolution === false, 'Expected isSolution=false');
  console.assert(r2.evidence.length === 2, `Expected 2 evidence items, got ${r2.evidence.length}`);
  console.assert(r2.evidence[1].type === 'multi-implementation', `Expected multi-implementation, got ${r2.evidence[1].type}`);
  console.log('  \u2713 Capability response parsed correctly');

  // ── Test 3: Parse response without evidence/references blocks ──────
  console.log('\n--- Test 3: Minimal response (no blocks) ---');
  const minimalResponse = `classification=SOLUTION
confidence=0.75
reasoning=Docker is a well-known containerization platform`;

  const r3 = parseWebSearchResponse(minimalResponse, 'Docker');
  console.assert(r3.classification === 'solution', `Expected solution, got ${r3.classification}`);
  console.assert(r3.confidence === 0.75, `Expected 0.75, got ${r3.confidence}`);
  console.assert(r3.evidence.length === 0, `Expected 0 evidence, got ${r3.evidence.length}`);
  console.assert(r3.references.length === 0, `Expected 0 references, got ${r3.references.length}`);
  console.log('  \u2713 Minimal response parsed correctly');

  // ── Test 4: Parse unstructured response ────────────────────────────
  console.log('\n--- Test 4: Unstructured response (keyword inference) ---');
  const unstructuredResponse = `After searching the web, I found that Kubernetes has an official website at kubernetes.io,
was developed by Google, and has a large open-source project on GitHub. It is a specific software platform
used for container orchestration. There is pricing for managed versions like GKE and EKS.`;

  const r4 = parseWebSearchResponse(unstructuredResponse, 'Kubernetes');
  console.assert(r4.classification === 'solution', `Expected solution from keywords, got ${r4.classification}`);
  console.assert(r4.method === 'web-search', `Expected web-search, got ${r4.method}`);
  console.log(`  \u2713 Inferred solution from keywords (confidence=${r4.confidence})`);

  // ── Test 5: Empty/null responses ───────────────────────────────────
  console.log('\n--- Test 5: Edge cases ---');
  const r5a = parseWebSearchResponse('', 'test');
  console.assert(r5a.classification === 'capability', 'Empty → capability');
  console.assert(r5a.confidence === 0.40, 'Empty → 0.40 confidence');

  const r5b = parseWebSearchResponse(null, 'test');
  console.assert(r5b.classification === 'capability', 'Null → capability');

  console.log('  \u2713 Empty/null responses handled');

  // ── Test 6: verifyViaWebSearch with mock ───────────────────────────
  console.log('\n--- Test 6: verifyViaWebSearch with mock ---');
  const mockWebSearch = async (prompt: string): Promise<string> => {
    if (prompt.includes('Kubernetes')) {
      return `classification=SOLUTION\nconfidence=0.95\nreasoning=Kubernetes is a specific platform by CNCF\nEVIDENCE_START\ntype=product-page|description=kubernetes.io|source=kubernetes.io|supports=solution\nEVIDENCE_END\nREFERENCES_START\ntitle=Kubernetes|url=https://kubernetes.io|snippet=Container orchestration platform\nREFERENCES_END`;
    }
    return `classification=CAPABILITY\nconfidence=0.85\nreasoning=This is a general concept`;
  };

  const r6a = await verifyViaWebSearch('Kubernetes', { webSearchCall: mockWebSearch });
  console.assert(r6a.classification === 'solution', `Expected solution, got ${r6a.classification}`);
  console.assert(r6a.confidence === 0.95, `Expected 0.95, got ${r6a.confidence}`);
  console.assert(r6a.evidence.length === 1, `Expected 1 evidence, got ${r6a.evidence.length}`);
  console.assert(r6a.references.length === 1, `Expected 1 reference, got ${r6a.references.length}`);
  console.log(`  \u2713 Kubernetes: ${r6a.classification} (${r6a.confidence})`);

  const r6b = await verifyViaWebSearch('data warehousing', { webSearchCall: mockWebSearch });
  console.assert(r6b.classification === 'capability', `Expected capability, got ${r6b.classification}`);
  console.log(`  \u2713 data warehousing: ${r6b.classification} (${r6b.confidence})`);

  // ── Test 7: Empty name ─────────────────────────────────────────────
  console.log('\n--- Test 7: Empty name ---');
  const r7 = await verifyViaWebSearch('', { webSearchCall: mockWebSearch });
  console.assert(r7.classification === 'capability', 'Empty → capability');
  console.assert(r7.confidence === 0.40, 'Empty → 0.40');
  console.log('  \u2713 Empty name handled');

  // ── Test 8: Web search error handling ──────────────────────────────
  console.log('\n--- Test 8: Error handling ---');
  const failingSearch = async () => { throw new Error('Network timeout'); };
  const r8 = await verifyViaWebSearch('SomeProduct', { webSearchCall: failingSearch });
  console.assert(r8.classification === 'capability', 'Error → capability fallback');
  console.assert(r8.confidence <= 0.40, `Error → low confidence, got ${r8.confidence}`);
  console.assert((r8 as any).error === 'Network timeout', `Expected error message, got ${(r8 as any).error}`);
  console.log(`  \u2713 Error handled gracefully (confidence=${r8.confidence})`);

  // ── Test 9: combineWithPriorResult ─────────────────────────────────
  console.log('\n--- Test 9: Combine with prior result ---');
  const prior = { classification: 'solution', confidence: 0.70, method: 'naming', reasoning: 'has version number' };
  const web: any = { classification: 'solution', confidence: 0.90, method: 'web-search', reasoning: 'has official website', isSolution: true, evidence: [], references: [] };

  const combined = combineWithPriorResult(prior, web);
  console.assert(combined.confidence >= 0.88, `Agreement should boost confidence above average, got ${combined.confidence}`);
  console.assert(combined.method === 'naming+web-search', `Expected naming+web-search, got ${combined.method}`);
  console.log(`  \u2713 Agreement boosts confidence: ${combined.confidence}`);

  const disagree = combineWithPriorResult(
    { classification: 'capability', confidence: 0.70, method: 'naming', reasoning: 'abstract term' },
    { classification: 'solution', confidence: 0.85, method: 'web-search', reasoning: 'found product page', isSolution: true, evidence: [], references: [] }
  );
  console.assert(disagree.classification === 'solution', 'Web search takes priority');
  console.assert(disagree.confidence < 0.85, `Disagreement should reduce confidence, got ${disagree.confidence}`);
  console.log(`  \u2713 Disagreement: web search wins with reduced confidence: ${disagree.confidence}`);

  // ── Test 10: Confidence clamping ───────────────────────────────────
  console.log('\n--- Test 10: Confidence clamping ---');
  const r10 = parseWebSearchResponse('classification=SOLUTION\nconfidence=1.50\nreasoning=test', 'test');
  console.assert(r10.confidence === 1.0, `Expected clamped to 1.0, got ${r10.confidence}`);
  const r10b = parseWebSearchResponse('classification=SOLUTION\nconfidence=-0.5\nreasoning=test', 'test');
  console.assert(r10b.confidence === 0.0, `Expected clamped to 0.0, got ${r10b.confidence}`);
  console.log('  \u2713 Confidence clamped to [0, 1]');

  console.log('\n=== self-test complete ===');
}
