// Pipeline-enriched evaluation mode for estimateEvolution
//
// When pipeline: true is passed, orchestrates 3 evaluations:
//   1. Capability pivot — the abstract capability is evaluated first as central anchor
//   2. State-of-the-art solution — a modern/SotA implementation of that capability
//   3. Legacy solution — an older/legacy implementation
//
// Produces a complete OWM (onlinewardleymaps.com) output with pipeline syntax
// containing component, pipeline, and label declarations.
//
// The capability is always the pivot: it is evaluated first, and its evolution
// score anchors the pipeline range.

import { logDebug, logInfo } from '../../lib/mcp-notifications.mjs';
import { dispatchSolutionStrategies } from '../routing/solution-dispatch.mjs';
import { toErrorMessage, errorCode } from '../../lib/errors.mjs';

const TOOL = 'estimateEvolution:pipeline';

// ─── Step 1: Capability Evaluation ─────────────────────────────────────────

/**
 * @typedef {Object} CapabilityPivotResult
 * @property {string}  capabilityName   - The abstract capability name (e.g. "Manage customer relationships")
 * @property {string}  nature           - Capability nature (activity/practice/data/knowledge)
 * @property {number}  evolution        - Evolution score [0, 1]
 * @property {number}  confidence       - Confidence in the evolution score [0, 1]
 * @property {string}  method           - Strategy method that produced the score
 * @property {Object}  evaluations      - Full evaluation results from all strategies
 * @property {Object}  wardleyType      - Wardley component type metadata
 * @property {Object}  routing          - Routing metadata from the evaluation
 */

/**
 * Evaluate the capability pivot — the first step of the enriched pipeline.
 *
 * Given the standard estimateEvolution result (which already ran capability
 * strategies), this function extracts the capability evolution score and
 * wraps it in a structured CapabilityPivotResult.
 *
 * If the input was originally a solution (e.g. "Kubernetes"), the capability
 * was already identified via identifyCapability (e.g. "Orchestrate containers").
 * In that case, this function re-evaluates the capability directly as a
 * generic capability through the capability strategies.
 *
 * If the input was already a capability (e.g. "container orchestration"),
 * the standard evaluation results are used directly — no re-evaluation needed.
 *
 * @param {Object} standardResult - The standard estimateEvolution oneshot result
 * @param {Object} component      - The original component input with identified capability
 * @param {Object} options
 * @param {Function} options.evaluateCapabilityFn - Function to evaluate a capability (accepts {name, description, strategy})
 * @returns {Promise<CapabilityPivotResult>}
 */
export async function evaluateCapabilityPivot(standardResult: any, component: any, options: any = {}): Promise<any> {  // any: heterogeneous pipeline options/result bag
  const { evaluateCapabilityFn } = options;

  const isSolution = standardResult.routing?.usedSolutionStrategies === true;
  const capabilityName = component.capability || component.name;
  const nature = component.nature || 'activity';

  logDebug(TOOL, `Capability pivot: name="${capabilityName}", nature="${nature}", isSolution=${isSolution}`);

  let capabilityEvaluations;
  let capabilityRouting;
  let capabilityWardleyType;

  if (isSolution && evaluateCapabilityFn && component.capability) {
    // The input was a solution — we need to evaluate the underlying capability separately
    logDebug(TOOL, `Re-evaluating capability "${capabilityName}" independently (input was solution "${component.name}")`);

    const capResult = await evaluateCapabilityFn({
      name: capabilityName,
      description: component.description,
      context: component.context,
      strategy: 'all',
      space: 'economic',
    });

    capabilityEvaluations = capResult.evaluations || {};
    capabilityRouting = capResult.routing || {};
    capabilityWardleyType = capResult.wardleyType || {};
  } else {
    // The input was already a capability — use the standard result's capability evaluations
    logDebug(TOOL, `Using standard evaluation for capability "${capabilityName}" (input was already a capability)`);

    capabilityEvaluations = standardResult.evaluations || {};
    capabilityRouting = standardResult.routing || {};
    capabilityWardleyType = standardResult.wardleyType || {};
  }

  // Extract the best evolution score from capability evaluations
  const { evolution, confidence, method } = extractBestEvolution(capabilityEvaluations);

  logDebug(TOOL, `Capability pivot result: evolution=${evolution}, confidence=${confidence}, method="${method}"`);

  return {
    capabilityName,
    nature,
    evolution,
    confidence,
    method,
    evaluations: capabilityEvaluations,
    wardleyType: capabilityWardleyType,
    routing: capabilityRouting,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract the best (highest confidence) evolution score from a set of evaluations.
 *
 * @param {Object<string, { evolution?: number, confidence?: number, error?: string }>} evaluations
 * @returns {{ evolution: number, confidence: number, method: string }}
 */
// any: evaluations is a Record<string, EvolutionResult|{error}> map
function extractBestEvolution(evaluations: any): any {
  let bestEvolution = 0.5;
  let bestConfidence = 0;
  let bestMethod = 'unknown';

  for (const [method, result] of Object.entries(evaluations) as [string, any][]) {
    if (result.error || result.evolution == null) continue;
    if (result.confidence > bestConfidence) {
      bestEvolution = result.evolution;
      bestConfidence = result.confidence;
      bestMethod = method;
    }
  }

  return { evolution: bestEvolution, confidence: bestConfidence, method: bestMethod };
}

// ─── Capability Bounding ─────────────────────────────────────────────────

/**
 * Clamp the capability evolution between the SotA (upper bound) and legacy
 * (lower bound) solution evolutions.
 *
 * In Wardley Mapping, the abstract capability should sit between its most
 * evolved implementation (SotA) and its least evolved one (legacy).
 * If only one bound is available, only that bound is enforced.
 * If neither bound is available, the evolution is returned unchanged.
 *
 * @param {number} capabilityEvolution - The raw capability evolution score
 * @param {number|null} sotaEvolution  - SotA solution evolution (upper bound), or null
 * @param {number|null} legacyEvolution - Legacy solution evolution (lower bound), or null
 * @returns {{ evolution: number, clamped: boolean, originalEvolution: number }}
 */
export function clampCapabilityEvolution(capabilityEvolution: number, sotaEvolution: number, legacyEvolution: number) {
  const original = capabilityEvolution;
  let clamped = false;
  let evolution = capabilityEvolution;

  // Determine effective bounds (only apply when values are valid numbers)
  const hasUpper = sotaEvolution != null && Number.isFinite(sotaEvolution);
  const hasLower = legacyEvolution != null && Number.isFinite(legacyEvolution);

  if (hasLower && evolution < legacyEvolution) {
    evolution = legacyEvolution;
    clamped = true;
  }

  if (hasUpper && evolution > sotaEvolution) {
    evolution = sotaEvolution;
    clamped = true;
  }

  // Final [0, 1] safety clamp
  evolution = Math.max(0, Math.min(1, evolution));

  return {
    evolution: Math.round(evolution * 1000) / 1000,
    clamped,
    originalEvolution: original,
  };
}

// ─── OWM Syntax Generation ────────────────────────────────────────────────

/**
 * Default visibility (y-axis) for the pipeline component in OWM maps.
 * Follows the convention from CPC strategy: 0.51 places the component
 * in the middle of the value chain.
 */
const DEFAULT_VISIBILITY = 0.51;

/**
 * Quote a component name for OWM syntax if it contains spaces.
 * @param {string} name
 * @returns {string} Quoted name if necessary
 */
function wmQuote(name: string | null | undefined): string {
  if (!name) return '"Component"';
  const clean = name.replace(/"/g, "'");
  return clean.includes(' ') ? `"${clean}"` : clean;
}

/**
 * Round a number to 2 decimal places for OWM coordinates.
 * @param {number} n
 * @returns {number}
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generate valid onlinewardleymaps.com OWM syntax for a 3-component pipeline.
 *
 * The output format is:
 *
 *   component "Capability Label" [visibility, pipeline_min] label [-53, -17]
 *   pipeline "Capability Label"
 *   {
 *       component "Legacy Solution" [evolution] label [-61, -23]
 *       component "Input Component" [evolution] label [-31, -3]
 *       component "SotA Solution" [evolution] label [-4, 30]
 *   }
 *
 * The capability is the outer pipeline container. Its evolution coordinate
 * is the pipeline minimum (leftmost inner component evolution minus a small
 * margin). The pipeline range spans from legacy (lowest) to SotA (highest).
 *
 * Inner components are ordered left-to-right by evolution (legacy → SotA).
 *
 * @param {Object} params
 * @param {string} params.capabilityLabel  - Display label for the capability pipeline
 * @param {number} params.capabilityEvolution - Evolution score of the capability pivot
 * @param {string} params.componentName    - Original input component name
 * @param {number} params.componentEvolution - Evolution of the input component (may equal SotA or legacy)
 * @param {string} [params.sotaName]       - Name of the state-of-the-art solution
 * @param {number} [params.sotaEvolution]  - Evolution of the SotA solution
 * @param {string} [params.legacyName]     - Name of the legacy solution
 * @param {number} [params.legacyEvolution] - Evolution of the legacy solution
 * @param {number} [params.visibility]     - Y-axis visibility (default: 0.51)
 * @param {string} [params.nature]         - Component nature (activity/practice/data/knowledge) — metadata only
 * @returns {string} Valid OWM syntax string
 */
// any: params bag for OWM syntax generation (component, anchor, label, evolution, ...)
export function generateOwmSyntax(params: any): string {
  const {
    capabilityLabel = 'Capability',
    capabilityEvolution = 0.5,
    componentName,
    componentEvolution,
    sotaName = null,
    sotaEvolution = null,
    legacyName = null,
    legacyEvolution = null,
    visibility = DEFAULT_VISIBILITY,
    nature = 'activity',
  } = params;

  // ── Collect inner components ────────────────────────────────────────────
  // Each inner component: { name, evolution }
  // We always have at least the input component; SotA and legacy are optional.
  const innerComponents = [];

  if (legacyName != null && legacyEvolution != null) {
    innerComponents.push({ name: legacyName, evolution: round2(legacyEvolution) });
  }

  // The input component itself (if distinct from SotA and legacy)
  if (componentName != null && componentEvolution != null) {
    innerComponents.push({ name: componentName, evolution: round2(componentEvolution) });
  }

  if (sotaName != null && sotaEvolution != null) {
    innerComponents.push({ name: sotaName, evolution: round2(sotaEvolution) });
  }

  // Deduplicate by name (if input component is same as SotA or legacy, keep one)
  const seen = new Set();
  const deduped = [];
  for (const ic of innerComponents) {
    const key = ic.name.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(ic);
    }
  }

  // Sort by evolution ascending (left → right on the map: legacy → SotA)
  deduped.sort((a, b) => a.evolution - b.evolution);

  // ── Compute pipeline range ──────────────────────────────────────────────
  // Pipeline min = leftmost component evolution minus a small margin
  // Pipeline max is implicit from the rightmost component
  const evolutions = deduped.map(c => c.evolution);
  const pipelineMin = round2(Math.max(0, Math.min(...evolutions) - 0.05));

  // ── Build OWM lines ─────────────────────────────────────────────────────
  const capLabel = wmQuote(capabilityLabel);
  const vis = round2(visibility);

  const lines = [];

  // Nature as OWM comment (informative metadata)
  lines.push(`// nature: ${nature}`);

  // Outer pipeline component: [visibility, pipeline_min_evolution]
  lines.push(`component ${capLabel} [${vis}, ${pipelineMin}] label [-53, -17]`);
  lines.push(`pipeline ${capLabel}`);
  lines.push(`{`);

  // Inner components with staggered label offsets to avoid overlap
  const labelOffsets = [
    '[-61, -23]',   // leftmost (legacy)
    '[-31, -3]',    // middle (input/capability)
    '[-4, 30]',     // rightmost (SotA)
  ];

  for (let i = 0; i < deduped.length; i++) {
    const ic = deduped[i];
    const labelOffset = labelOffsets[Math.min(i, labelOffsets.length - 1)];
    lines.push(`    component ${wmQuote(ic.name)} [${ic.evolution}] label ${labelOffset}`);
  }

  lines.push(`}`);

  return lines.join('\n');
}

// ─── Step 2: Solution Discovery ──────────────────────────────────────────

/**
 * @typedef {Object} DiscoveredSolution
 * @property {string} name        - Solution name (e.g. "Kubernetes", "Docker Swarm")
 * @property {string} description - Brief description of the solution
 * @property {'sota'|'legacy'} role - Whether this is the SotA or legacy solution
 */

/**
 * @typedef {Object} SolutionDiscoveryResult
 * @property {DiscoveredSolution|null} sota   - State-of-the-art / cutting-edge solution
 * @property {DiscoveredSolution|null} legacy - Legacy / established / older solution
 * @property {string} capabilityUsed          - The capability name used for discovery
 * @property {number} confidence              - Confidence in the discovery (0–1)
 */

/**
 * LLM prompt template for discovering representative solutions for a capability.
 *
 * Given a generic capability, the LLM identifies:
 *   - A state-of-the-art (SotA) solution: the most modern, cutting-edge implementation
 *   - A legacy solution: an older, well-established but less evolved implementation
 *
 * Both solutions must be NAMED (proper nouns with specific identity) — not generic
 * descriptions. They should represent opposite ends of the evolution spectrum for
 * the same underlying capability.
 */
const SOLUTION_DISCOVERY_PROMPT = `You are an expert in Wardley Mapping and technology evolution.

Given a GENERIC CAPABILITY, identify TWO named solutions that represent it at different evolution stages:

1. **STATE-OF-THE-ART (SotA)**: The most modern, cutting-edge, or innovative named solution currently addressing this capability. It should be a specific product, framework, platform, methodology, or standard — NOT a generic description. SotA solutions are typically in the Product or early Commodity phase of evolution.

2. **LEGACY**: An older, well-established named solution for the same capability. It was once state-of-the-art but has been superseded by newer alternatives. Legacy solutions are typically in the Custom or early Product phase — still used but showing their age.

IMPORTANT RULES:
- Both answers MUST be SPECIFIC NAMED solutions (proper nouns): products, frameworks, platforms, methodologies, standards, or specifications.
- Do NOT return generic descriptions (e.g. "modern CI/CD tool" is NOT valid; "GitHub Actions" IS valid).
- The SotA solution should be MORE evolved (higher on the Wardley evolution axis) than the legacy solution.
- If the original input component is itself a named solution, do NOT repeat it — choose different representative solutions.
- Choose solutions that are widely recognized and representative of their evolution stage.

Capability: "{{capability}}"
{{contextLine}}
{{excludeLine}}

MANDATORY OUTPUT FORMAT (exactly 6 lines, no additional text):
sota_name=<specific solution name>
sota_description=<one sentence describing what it is and why it's SotA>
legacy_name=<specific solution name>
legacy_description=<one sentence describing what it is and why it's legacy>
confidence=<0.XX>
reasoning=<one sentence explaining your choices>`;

/**
 * Parse the LLM response for solution discovery into a structured result.
 *
 * Expected format:
 *   sota_name=GitHub Actions
 *   sota_description=Modern cloud-native CI/CD platform integrated with GitHub
 *   legacy_name=Jenkins
 *   legacy_description=Established open-source automation server, widely used but complex to maintain
 *   confidence=0.88
 *   reasoning=GitHub Actions represents modern SotA while Jenkins is the canonical legacy CI/CD tool
 *
 * @param {string} text           - Raw LLM response
 * @param {string} capabilityName - Capability used for context in error messages
 * @returns {SolutionDiscoveryResult}
 */
export function parseSolutionDiscoveryResponse(text: string, capabilityName: string): any {
  const sotaNameMatch = text.match(/^sota_name\s*=\s*(.+)/mi);
  const sotaDescMatch = text.match(/^sota_description\s*=\s*(.+)/mi);
  const legacyNameMatch = text.match(/^legacy_name\s*=\s*(.+)/mi);
  const legacyDescMatch = text.match(/^legacy_description\s*=\s*(.+)/mi);
  const confMatch = text.match(/^confidence\s*=\s*(-?[\d.]+)/mi);
  const reasonMatch = text.match(/^reasoning\s*=\s*(.+)/mi);

  const confidence = confMatch
    ? Math.round(Math.max(0, Math.min(1, parseFloat(confMatch[1]))) * 100) / 100
    : 0.60;

  // Build SotA solution (if found)
  let sota = null;
  if (sotaNameMatch) {
    const name = sotaNameMatch[1].trim();
    if (name && name.length > 0 && !/^(none|n\/a|unknown|not applicable)$/i.test(name)) {
      sota = {
        name,
        description: sotaDescMatch ? sotaDescMatch[1].trim() : `State-of-the-art solution for ${capabilityName}`,
        role: 'sota',
      };
    }
  }

  // Build legacy solution (if found)
  let legacy = null;
  if (legacyNameMatch) {
    const name = legacyNameMatch[1].trim();
    if (name && name.length > 0 && !/^(none|n\/a|unknown|not applicable)$/i.test(name)) {
      legacy = {
        name,
        description: legacyDescMatch ? legacyDescMatch[1].trim() : `Legacy solution for ${capabilityName}`,
        role: 'legacy',
      };
    }
  }

  return {
    sota,
    legacy,
    capabilityUsed: capabilityName,
    confidence,
    reasoning: reasonMatch ? reasonMatch[1].trim() : null,
  };
}

/**
 * Discover two representative solutions (SotA + legacy) for a given capability
 * using the Tier 2 LLM.
 *
 * This is Step 2 of the enriched pipeline: after the capability pivot is
 * evaluated, we identify which named solutions sit at opposite ends of the
 * evolution axis for that capability.
 *
 * The discovered solutions are NOT yet evaluated — they are returned as
 * structured metadata for Step 3 (solution evaluation) to consume.
 *
 * @param {string} capabilityName - The generic capability name (e.g. "container orchestration")
 * @param {Object} options
 * @param {function(string): Promise<string>} options.llmCall - LLM call function
 * @param {string}   [options.description]    - Additional context about the capability
 * @param {string}   [options.excludeName]    - Original component name to exclude from results
 * @returns {Promise<SolutionDiscoveryResult>}
 */
export async function discoverPipelineSolutions(capabilityName: string, options: any = {}): Promise<any> {  // any: heterogeneous pipeline options/result bag
  const { llmCall, description = '', excludeName = '' } = options;

  if (!capabilityName || typeof capabilityName !== 'string') {
    logDebug(TOOL, 'discoverPipelineSolutions: empty capability — returning null results');
    return { sota: null, legacy: null, capabilityUsed: '', confidence: 0 };
  }

  if (typeof llmCall !== 'function') {
    logDebug(TOOL, 'discoverPipelineSolutions: no llmCall — returning null results');
    return { sota: null, legacy: null, capabilityUsed: capabilityName, confidence: 0 };
  }

  const trimmed = capabilityName.trim();

  const contextLine = description
    ? `Context: ${description}`
    : 'Context: (none provided)';

  const excludeLine = excludeName
    ? `Original component (do NOT repeat): "${excludeName}"`
    : '';

  const prompt = SOLUTION_DISCOVERY_PROMPT
    .replace('{{capability}}', trimmed)
    .replace('{{contextLine}}', contextLine)
    .replace('{{excludeLine}}', excludeLine);

  logDebug(TOOL, `Discovering solutions for capability "${trimmed}"${excludeName ? ` (excluding "${excludeName}")` : ''}...`);

  try {
    const response = await llmCall(prompt);
    const result = parseSolutionDiscoveryResponse(response, trimmed);

    logDebug(TOOL, `Solution discovery for "${trimmed}": ` +
      `sota="${result.sota?.name ?? '(none)'}", legacy="${result.legacy?.name ?? '(none)'}", ` +
      `confidence=${result.confidence}`);

    return result;
  } catch (err) {
    logDebug(TOOL, `Solution discovery failed for "${trimmed}": ${toErrorMessage(err)}`);
    return { sota: null, legacy: null, capabilityUsed: trimmed, confidence: 0 };
  }
}

// ─── Step 3: Solution Evaluation ────────────────────────────────────────

/**
 * Evaluate a single discovered solution (SotA or legacy) via the solution strategies
 * (12 Wardley properties). This reuses the same evaluation path as normal solution
 * evaluations through dispatchSolutionStrategies().
 *
 * @param {DiscoveredSolution} solution - The discovered solution (name, description, role)
 * @param {Object} options
 * @param {Function} options.llmCall - LLM call function
 * @returns {Promise<{ evolution: number|null, confidence: number, method: string, evaluations: Object }>}
 */
export async function evaluateDiscoveredSolution(solution: any, options: any = {}): Promise<any> {  // any: heterogeneous pipeline options/result bag
  const { llmCall } = options;

  if (!solution || !solution.name) {
    logDebug(TOOL, 'evaluateDiscoveredSolution: no solution provided');
    return { evolution: null, confidence: 0, method: 'none', evaluations: {} };
  }

  if (typeof llmCall !== 'function') {
    logDebug(TOOL, `evaluateDiscoveredSolution: no llmCall for "${solution.name}"`);
    return { evolution: null, confidence: 0, method: 'none', evaluations: {} };
  }

  logDebug(TOOL, `Evaluating ${solution.role} solution "${solution.name}" via solution strategies...`);

  // Build a component object compatible with dispatchSolutionStrategies
  const solutionComponent = {
    name: solution.name,
    description: solution.description || '',
    isSolution: true,
  };

  try {
    const evaluations = await dispatchSolutionStrategies(solutionComponent, {
      llmCall,
      strategy: 'all',
      mode: 'auto',
    });

    // Extract best evolution from the solution strategy evaluations
    const { evolution, confidence, method } = extractBestEvolution(evaluations);

    logDebug(TOOL, `${solution.role} solution "${solution.name}": evolution=${evolution}, confidence=${confidence}, method="${method}"`);

    return { evolution, confidence, method, evaluations };
  } catch (err) {
    logDebug(TOOL, `evaluateDiscoveredSolution failed for "${solution.name}": ${toErrorMessage(err)}`);
    return { evolution: null, confidence: 0, method: 'error', evaluations: { error: toErrorMessage(err) } };
  }
}

// ─── Full Pipeline Orchestration ──────────────────────────────────────────

/**
 * Run the full enriched pipeline: capability pivot + SotA solution + legacy solution.
 *
 * Implements:
 *   - Step 1: Capability pivot evaluation (always first)
 *   - Step 2: Solution discovery — identifies SotA and legacy solutions via LLM
 *   - Step 3: Solution evaluation — evaluates SotA and legacy via 12 Wardley property strategies
 *
 * OWM syntax is generated when all 3 components are available, or partially
 * when at least the capability pivot is evaluated.
 *
 * @param {Object} standardResult - The standard estimateEvolution result
 * @param {Object} component      - The original component with identified capability
 * @param {Object} options
 * @param {Function} options.evaluateCapabilityFn - Evaluator function for capability
 * @param {Function} [options.llmCall]            - LLM call function for solution discovery
 * @returns {Promise<Object>} Pipeline result with capability pivot, OWM output, and discovered solutions
 */
export async function runEnrichedPipeline(standardResult: any, component: any, options: any = {}): Promise<any> {  // any: heterogeneous pipeline options/result bag
  logInfo(TOOL, `Starting enriched pipeline for "${component.name}"`);

  // Step 1: Capability pivot — always first
  const capabilityPivot = await evaluateCapabilityPivot(standardResult, component, options);

  logInfo(TOOL, `Pipeline step 1 complete: capability="${capabilityPivot.capabilityName}", evolution=${capabilityPivot.evolution}`);

  // Step 2: Solution discovery — identify SotA and legacy solutions for the capability
  const discoveredSolutions = await discoverPipelineSolutions(
    capabilityPivot.capabilityName,
    {
      llmCall: options.llmCall,
      description: component.description,
      context: component.context,
      excludeName: component.name,
    },
  );

  if (discoveredSolutions.sota || discoveredSolutions.legacy) {
    logInfo(TOOL, `Pipeline step 2 complete: sota="${discoveredSolutions.sota?.name ?? '(none)'}", ` +
      `legacy="${discoveredSolutions.legacy?.name ?? '(none)'}" (confidence=${discoveredSolutions.confidence})`);
  } else {
    logInfo(TOOL, `Pipeline step 2: no solutions discovered for "${capabilityPivot.capabilityName}"`);
  }

  // Step 3: Solution evaluation — evaluate discovered solutions via solution strategies (12 properties)
  // Both SotA and legacy go through the same evaluateDiscoveredSolution path,
  // which dispatches to the solution strategies pipeline (12 Wardley properties).

  // SotA evaluation
  let sotaSolution = null;
  if (discoveredSolutions.sota) {
    const sotaEval = await evaluateDiscoveredSolution(discoveredSolutions.sota, { llmCall: options.llmCall });
    sotaSolution = {
      ...discoveredSolutions.sota,
      evolution: sotaEval.evolution,
      confidence: sotaEval.confidence,
      method: sotaEval.method,
      evaluations: sotaEval.evaluations,
    };
    logInfo(TOOL, `Pipeline step 3 (sota): "${sotaSolution.name}" evolution=${sotaSolution.evolution}`);
  }

  // Legacy evaluation — evaluate via the same solution strategies pipeline as normal solutions
  let legacySolution = null;
  if (discoveredSolutions.legacy) {
    const legacyEval = await evaluateDiscoveredSolution(discoveredSolutions.legacy, { llmCall: options.llmCall });
    legacySolution = {
      ...discoveredSolutions.legacy,
      evolution: legacyEval.evolution,
      confidence: legacyEval.confidence,
      method: legacyEval.method,
      evaluations: legacyEval.evaluations,
    };
    logInfo(TOOL, `Pipeline step 3 (legacy): "${legacySolution.name}" evolution=${legacySolution.evolution}`);
  }

  // Generate OWM syntax with whatever components are available
  const capabilityLabel = component.capabilityLabel || capabilityPivot.capabilityName || 'Capability';
  const owm = generateOwmSyntax({
    capabilityLabel,
    capabilityEvolution: capabilityPivot.evolution,
    componentName: component.name,
    componentEvolution: standardResult?.evolution ?? capabilityPivot.evolution,
    sotaName: sotaSolution?.name ?? null,
    sotaEvolution: sotaSolution?.evolution ?? null,
    legacyName: legacySolution?.name ?? null,
    legacyEvolution: legacySolution?.evolution ?? null,
    visibility: DEFAULT_VISIBILITY,
    nature: capabilityPivot.nature || 'activity',
  });

  logInfo(TOOL, `OWM syntax generated (${owm.split('\n').length} lines)`);

  // Build pipeline result
  const pipelineResult = {
    pipeline: true,
    componentName: component.name,
    capabilityPivot,
    sotaSolution,
    legacySolution,
    discoveredSolutions,
    owm,
    owmOutput: owm,  // canonical field name for the OWM syntax output
    // Standard result preserved for backward compatibility
    standardResult,
  };

  return pipelineResult;
}
