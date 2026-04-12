// Solution vs Capability detection for Wardley Map components
//
// This module determines whether a component name refers to a concrete
// solution/product (e.g. "Kubernetes", "Salesforce", "SAP ERP") or an
// abstract capability (e.g. "container orchestration", "CRM", "data storage").
//
// Detection pipeline (two-tier):
//   1. Naming convention heuristics (fast, no LLM cost)
//      → If confidence >= 90%, return immediately
//   2. LLM-based verification (fallback when heuristics are uncertain)
//      → Uses the configured LLM backend for semantic classification
//
// The result drives exclusive routing in the evolution evaluation pipeline:
//   - Solutions  → src/solution-strategies/ (12-property phase reference)
//   - Capabilities → src/strategies/        (existing capability strategies)
//
// Routing mode controlled by WARDLEY_EVAL_MODE env var:
//   - "exclusive" (default): only one pipeline runs
//   - "parallel": both pipelines run, results merged
//
// Usage:
//   import { detectSolution, classifySolutionLLM } from './detect-solution.mjs';
//
//   const result = await detectSolution('Kubernetes', { context: '...' });
//   // → { classification: 'solution', confidence: 0.95, method: 'naming', ... }
//
//   const llmResult = await classifySolutionLLM('ERP', llmCall, { context: '...' });
//   // → { classification: 'capability', confidence: 0.82, reasoning: '...' }

import { logDebug } from '../../lib/mcp-notifications.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Confidence threshold: if naming heuristics reach this, skip LLM fallback */
const NAMING_CONFIDENCE_THRESHOLD = 0.90;

/** Classification values */
export const CLASSIFICATION = {
  SOLUTION: 'solution',
  CAPABILITY: 'capability',
};

// ─── Result Type ──────────────────────────────────────────────────────────────

/**
 * @typedef {Object} SolutionDetectionResult
 * @property {'solution'|'capability'} classification - Component type
 * @property {number}  confidence  - Confidence score (0–1)
 * @property {string}  method      - Detection method used: 'naming' | 'llm' | 'naming+llm'
 * @property {string}  reasoning   - Human-readable explanation of the classification
 * @property {boolean} isSolution  - Convenience flag: true if classification === 'solution'
 */

// ─── Known Solutions Database ─────────────────────────────────────────────────
// Well-known commercial products, platforms, and services that are concrete
// solutions (not abstract capabilities). This list powers the high-confidence
// naming convention tier.

const KNOWN_SOLUTIONS = new Set([
  // Cloud platforms
  'aws', 'amazon web services', 'azure', 'microsoft azure', 'gcp',
  'google cloud', 'google cloud platform', 'heroku', 'digitalocean',
  'linode', 'vultr', 'oracle cloud', 'ibm cloud', 'alibaba cloud',
  'cloudflare', 'vercel', 'netlify', 'railway', 'fly.io', 'render',

  // Container / orchestration
  'kubernetes', 'k8s', 'docker', 'openshift', 'rancher', 'nomad',
  'docker swarm', 'amazon ecs', 'amazon eks', 'azure aks', 'gke',
  'google kubernetes engine', 'podman',

  // Databases
  'postgresql', 'postgres', 'mysql', 'mariadb', 'mongodb', 'redis',
  'elasticsearch', 'opensearch', 'cassandra', 'dynamodb', 'cosmosdb',
  'cockroachdb', 'neo4j', 'couchdb', 'influxdb', 'timescaledb',
  'supabase', 'firebase', 'planetscale', 'neon', 'sqlite',
  'oracle database', 'sql server', 'microsoft sql server', 'snowflake',
  'bigquery', 'redshift', 'databricks', 'clickhouse',

  // CRM / ERP / Business solutions
  'salesforce', 'hubspot', 'zoho', 'sap', 'sap erp', 'sap s/4hana',
  'oracle erp', 'netsuite', 'dynamics 365', 'microsoft dynamics',
  'workday', 'servicenow', 'zendesk', 'freshdesk', 'jira',
  'monday.com', 'asana', 'trello', 'notion', 'clickup', 'airtable',
  'pipedrive', 'insightly',

  // CI/CD / DevOps
  'jenkins', 'github actions', 'gitlab ci', 'circleci', 'travis ci',
  'teamcity', 'bamboo', 'argo cd', 'spinnaker', 'tekton',
  'terraform', 'pulumi', 'ansible', 'puppet', 'chef', 'saltstack',
  'packer', 'vagrant', 'helm', 'flux',

  // Messaging / streaming
  'kafka', 'apache kafka', 'rabbitmq', 'amazon sqs', 'amazon sns',
  'azure service bus', 'google pub/sub', 'nats', 'pulsar',
  'apache pulsar', 'activemq', 'zeromq',

  // Monitoring / observability
  'datadog', 'new relic', 'splunk', 'grafana', 'prometheus',
  'elastic apm', 'dynatrace', 'pagerduty', 'opsgenie',
  'sentry', 'honeycomb', 'lightstep',

  // AI / ML platforms
  'openai', 'chatgpt', 'gpt-4', 'claude', 'anthropic', 'gemini',
  'bard', 'copilot', 'github copilot', 'hugging face', 'sagemaker',
  'vertex ai', 'azure ml', 'mlflow', 'wandb', 'comet',
  'langchain', 'llamaindex',

  // Communication / collaboration
  'slack', 'microsoft teams', 'zoom', 'discord', 'telegram',
  'twilio', 'sendgrid', 'mailchimp', 'intercom', 'drift',

  // Web frameworks / runtimes (as solutions)
  'react', 'angular', 'vue', 'vue.js', 'next.js', 'nextjs',
  'nuxt', 'nuxt.js', 'svelte', 'sveltekit', 'remix',
  'node.js', 'nodejs', 'deno', 'bun',
  'spring boot', 'django', 'rails', 'ruby on rails',
  'laravel', 'flask', 'fastapi', 'express', 'express.js',
  'nest.js', 'nestjs',

  // Security
  'okta', 'auth0', 'keycloak', 'vault', 'hashicorp vault',
  'cloudflare waf', 'crowdstrike', 'palo alto', 'fortinet',
  'snyk', 'sonarqube', 'checkmarx', 'veracode',

  // CDN / edge
  'cloudflare cdn', 'akamai', 'fastly', 'cloudfront',
  'azure cdn', 'bunny cdn',

  // Payment / fintech
  'stripe', 'paypal', 'adyen', 'square', 'braintree', 'plaid',

  // Content / CMS
  'wordpress', 'contentful', 'strapi', 'sanity', 'ghost',
  'drupal', 'shopify', 'magento', 'woocommerce', 'bigcommerce',

  // Version control / code
  'github', 'gitlab', 'bitbucket', 'git', 'svn', 'perforce',

  // Misc enterprise
  'tableau', 'power bi', 'looker', 'metabase', 'amplitude',
  'mixpanel', 'segment', 'mparticle', 'rudderstack',
  'confluence', 'sharepoint', 'box', 'dropbox',
  'vmware', 'vsphere', 'hyper-v', 'proxmox',
]);

// ─── Naming Convention Patterns ───────────────────────────────────────────────
// Patterns that strongly indicate a solution (product/vendor name characteristics)

/**
 * Patterns that suggest a component name refers to a concrete solution.
 * Each pattern has a base confidence contribution.
 */
const SOLUTION_INDICATORS = [
  // Version numbers in name (e.g. "SAP S/4HANA", "Windows 11", "GPT-4")
  { pattern: /\d+(\.\d+)*/, weight: 0.25, reason: 'contains version number' },

  // Registered trademark signals
  { pattern: /[A-Z][a-z]+[A-Z]/, weight: 0.30, reason: 'camelCase product name (e.g. JavaScript, PostgreSQL)' },

  // Trademark/registered symbols
  { pattern: /[®™©]/, weight: 0.40, reason: 'contains trademark symbol' },

  // "by <company>" pattern
  { pattern: /\bby\s+[A-Z]/i, weight: 0.20, reason: 'contains "by <Company>" attribution' },

  // Known vendor suffixes (IO, AI, Cloud, Hub, Lab, etc.)
  { pattern: /\.(io|ai|com|cloud|dev|app|js|ts|py|rb|go|rs)$/i, weight: 0.30, reason: 'has product domain suffix' },

  // Abbreviation-style names (all caps, 2-5 chars): AWS, GCP, EKS, etc.
  { pattern: /^[A-Z]{2,5}$/, weight: 0.15, reason: 'uppercase abbreviation (potential product acronym)' },
];

/**
 * Patterns that suggest a component name refers to an abstract capability.
 * These reduce solution confidence when matched.
 */
const CAPABILITY_INDICATORS = [
  // Starts with infinitive verb (activity nature)
  { pattern: /^(manage|orchestrate|automate|process|handle|deliver|provide|build|create|monitor|analyze|store|compute|deploy|serve|route|transform|integrate|authenticate|authorize)\b/i, weight: 0.35, reason: 'starts with activity verb' },

  // "how to" pattern (practice nature)
  { pattern: /^how\s+to\b/i, weight: 0.45, reason: '"how to" practice pattern' },

  // Contains generic capability words
  { pattern: /\b(management|orchestration|automation|storage|processing|analytics|monitoring|security|authentication|authorization|networking|messaging|caching|logging|deployment|provisioning|scheduling|load.?balancing|service.?discovery)\b/i, weight: 0.30, reason: 'contains generic capability term' },

  // "technical expertise" or "interpersonal skills" (knowledge nature)
  { pattern: /\b(expertise|skills|know-how|knowledge|competence|proficiency)\b/i, weight: 0.35, reason: 'knowledge/skills nature indicator' },

  // Abstract nouns without branding
  { pattern: /\b(data|information|intelligence|insights|metrics|coordinates|temperature|rate|ratio|index)\b/i, weight: 0.20, reason: 'abstract data nature indicator' },
];

// ─── Naming Convention Detection ──────────────────────────────────────────────

/**
 * Classify a component name using naming convention heuristics (no LLM call).
 *
 * Returns a classification with confidence. If confidence >= 90%, the result
 * is considered reliable and the LLM fallback can be skipped.
 *
 * @param {string} name     - Component name to classify
 * @param {Object} [options]
 * @param {string} [options.context] - Additional context (boosts confidence if consistent)
 * @returns {SolutionDetectionResult}
 */
export function classifySolutionNaming(name, options = {}) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return {
      classification: CLASSIFICATION.CAPABILITY,
      confidence: 0.5,
      method: 'naming',
      reasoning: 'Empty component name — defaulting to capability',
      isSolution: false,
    };
  }

  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');

  // ── Tier 1: Known solutions database (high confidence) ──────────────
  if (KNOWN_SOLUTIONS.has(normalized)) {
    return {
      classification: CLASSIFICATION.SOLUTION,
      confidence: 0.97,
      method: 'naming',
      reasoning: `"${trimmed}" is a known solution/product in the reference database`,
      isSolution: true,
    };
  }

  // Check partial matches (e.g. "SAP S/4HANA" contains "sap")
  for (const known of KNOWN_SOLUTIONS) {
    if (known.length >= 3 && normalized.includes(known) && known.length >= normalized.length * 0.5) {
      return {
        classification: CLASSIFICATION.SOLUTION,
        confidence: 0.92,
        method: 'naming',
        reasoning: `"${trimmed}" contains known solution name "${known}"`,
        isSolution: true,
      };
    }
  }

  // ── Tier 2: Pattern-based scoring ───────────────────────────────────

  let solutionScore = 0;
  let capabilityScore = 0;
  const solutionReasons = [];
  const capabilityReasons = [];

  // Check solution patterns
  for (const indicator of SOLUTION_INDICATORS) {
    if (indicator.pattern.test(trimmed)) {
      solutionScore += indicator.weight;
      solutionReasons.push(indicator.reason);
    }
  }

  // Check capability patterns
  for (const indicator of CAPABILITY_INDICATORS) {
    if (indicator.pattern.test(trimmed)) {
      capabilityScore += indicator.weight;
      capabilityReasons.push(indicator.reason);
    }
  }

  // ── Tier 3: Contextual signals ──────────────────────────────────────
  const context = (options.context || '').toLowerCase();
  if (context) {
    // Context mentioning vendor/product/platform reinforces solution
    if (/\b(vendor|product|platform|provider|service|tool|software|saas|paas|iaas)\b/.test(context)) {
      solutionScore += 0.15;
      solutionReasons.push('context mentions vendor/product/platform');
    }
    // Context mentioning capability/need/function reinforces capability
    if (/\b(capability|need|function|process|activity|practice)\b/.test(context)) {
      capabilityScore += 0.15;
      capabilityReasons.push('context mentions capability/need/function');
    }
  }

  // ── Classification decision ─────────────────────────────────────────

  const totalScore = solutionScore + capabilityScore;

  if (totalScore === 0) {
    // No strong signals — uncertain, needs LLM fallback
    return {
      classification: CLASSIFICATION.CAPABILITY,
      confidence: 0.50,
      method: 'naming',
      reasoning: `No strong naming convention signals for "${trimmed}" — uncertain classification`,
      isSolution: false,
    };
  }

  const isSolution = solutionScore > capabilityScore;
  const dominantScore = Math.max(solutionScore, capabilityScore);

  // Confidence: proportional to how dominant the winning signal is
  // Scale from 0.55 (barely dominant) to 0.89 (strongly dominant pattern match)
  const dominanceRatio = dominantScore / totalScore;
  const rawConfidence = 0.55 + (dominanceRatio - 0.5) * 0.68;
  const confidence = Math.round(Math.min(0.89, Math.max(0.50, rawConfidence)) * 100) / 100;

  const reasons = isSolution ? solutionReasons : capabilityReasons;

  return {
    classification: isSolution ? CLASSIFICATION.SOLUTION : CLASSIFICATION.CAPABILITY,
    confidence,
    method: 'naming',
    reasoning: `"${trimmed}" classified as ${isSolution ? 'solution' : 'capability'} via naming patterns: ${reasons.join('; ')}`,
    isSolution,
  };
}

// ─── LLM-Based Classification ─────────────────────────────────────────────────

/**
 * LLM prompt for solution vs capability classification.
 *
 * The prompt is designed to:
 *   1. Explain the Wardley Mapping distinction between solutions and capabilities
 *   2. Ask for classification with confidence
 *   3. Require structured output for reliable parsing
 */
const SOLUTION_CLASSIFICATION_PROMPT = `You are an expert in Wardley Mapping and business capability modeling.

In Wardley Mapping, there is a critical distinction between NAMED COMPONENTS and GENERIC CAPABILITIES:

- **SOLUTIONS (named components)**: Any component with a SPECIFIC NAME, IDENTITY, or BRAND. This includes:
  • Commercial products & platforms: Kubernetes, Salesforce, SAP ERP, AWS Lambda, Docker
  • Frameworks & libraries: React, Spring Boot, TensorFlow, Angular, Bootstrap, .NET
  • Methodologies & named practices: Scrum, Kanban, Lean, Six Sigma, DevOps, Agile, SAFe, XP, Design Thinking, Wardley Mapping
  • Standards & specifications: ISO 27001, TOGAF, ITIL, COBIT, PCI-DSS, SOC 2, GDPR, OAuth 2.0, REST, GraphQL
  • Named models & theories: Porter's Five Forces, SWOT, OKR, Balanced Scorecard, Theory of Constraints, Jobs to Be Done
  • Open-source projects: Linux, Apache, Nginx, Git, Prometheus, Grafana
  The key test: does this component have a proper name, a creator/origin, and a distinct identity that distinguishes it from the generic capability it addresses?

- **CAPABILITIES (generic components)**: Abstract activities, practices, knowledge areas, or data types that describe WHAT needs to be done, not HOW. They have no specific identity and could be fulfilled by multiple named solutions. Examples: container orchestration, customer relationship management, enterprise resource planning, relational data storage, front-end rendering, serverless compute, infrastructure-as-code, team communication, containerization, project management, continuous improvement, quality management, IT service management, agile coaching.

Your task: classify the following component name as either a SOLUTION or a CAPABILITY.

Component: "{{name}}"
{{contextLine}}

Decision rules (apply in order):
1. Does this name refer to a SPECIFIC named product, framework, methodology, standard, model, or specification?
   → SOLUTION. Even if it is a methodology (Scrum), a standard (ITIL), or a framework (TOGAF), it is still a named component with a specific identity.
2. Does this name describe a GENERAL activity, practice area, knowledge domain, or data type without a specific identity?
   → CAPABILITY. Generic descriptions like "project management" or "quality assurance" are capabilities.
3. Some names are ambiguous (e.g., "Git" is both a solution AND the only common implementation, "Agile" can mean the methodology or the general concept). In such cases, lean toward SOLUTION if the name is typically capitalized or used as a proper noun in professional contexts.

MANDATORY OUTPUT FORMAT (exactly 3 lines, no additional text):
classification=SOLUTION or CAPABILITY
confidence=X.XX (a number between 0 and 1)
reasoning=<one sentence explaining your classification>`;

/**
 * Classify a component as solution or capability using LLM semantic analysis.
 *
 * This function is the fallback when naming convention heuristics don't
 * reach the 90% confidence threshold. It uses the configured LLM backend
 * for a more nuanced semantic classification.
 *
 * @param {string} name      - Component name to classify
 * @param {function(string): Promise<string>} llmCall - LLM call function (from llm-call.mjs)
 * @param {Object} [options]
 * @param {string} [options.context] - Additional context about the component
 * @returns {Promise<SolutionDetectionResult>}
 */
export async function classifySolutionLLM(name, llmCall, options = {}) {
  const trimmed = (name || '').trim();

  if (!trimmed) {
    return {
      classification: CLASSIFICATION.CAPABILITY,
      confidence: 0.5,
      method: 'llm',
      reasoning: 'Empty component name — defaulting to capability',
      isSolution: false,
    };
  }

  if (typeof llmCall !== 'function') {
    throw new Error('classifySolutionLLM requires an llmCall function');
  }

  const contextLine = options.context
    ? `Context: ${options.context}`
    : 'Context: (none provided)';

  const prompt = SOLUTION_CLASSIFICATION_PROMPT
    .replace('{{name}}', trimmed)
    .replace('{{contextLine}}', contextLine);

  logDebug('detectSolution', `LLM classification for "${trimmed}"...`);

  const response = await llmCall(prompt);
  const result = parseLLMClassificationResponse(response, trimmed);

  logDebug('detectSolution', `LLM result for "${trimmed}": ${result.classification} (confidence=${result.confidence})`);

  return result;
}

/**
 * Parse the LLM classification response into a structured result.
 *
 * Expected format:
 *   classification=SOLUTION or CAPABILITY
 *   confidence=0.XX
 *   reasoning=...
 *
 * @param {string} text - Raw LLM response
 * @param {string} name - Original component name (for error messages)
 * @returns {SolutionDetectionResult}
 */
export function parseLLMClassificationResponse(text, name) {
  const classMatch = text.match(/^classification\s*=\s*(solution|capability)/mi);
  const confMatch = text.match(/^confidence\s*=\s*(-?[\d.]+)/mi);
  const reasonMatch = text.match(/^reasoning\s*=\s*(.+)/mi);

  if (!classMatch) {
    // Fallback: try to find classification keywords anywhere
    const hasSolution = /\bsolution\b/i.test(text);
    const hasCapability = /\bcapability\b/i.test(text);

    if (hasSolution && !hasCapability) {
      return {
        classification: CLASSIFICATION.SOLUTION,
        confidence: 0.60,
        method: 'llm',
        reasoning: `LLM response suggested solution but format was non-standard for "${name}"`,
        isSolution: true,
      };
    }
    if (hasCapability && !hasSolution) {
      return {
        classification: CLASSIFICATION.CAPABILITY,
        confidence: 0.60,
        method: 'llm',
        reasoning: `LLM response suggested capability but format was non-standard for "${name}"`,
        isSolution: false,
      };
    }

    // Truly unparseable — default to capability with low confidence
    return {
      classification: CLASSIFICATION.CAPABILITY,
      confidence: 0.40,
      method: 'llm',
      reasoning: `Could not parse LLM classification response for "${name}"`,
      isSolution: false,
    };
  }

  const classification = classMatch[1].toLowerCase() === 'solution'
    ? CLASSIFICATION.SOLUTION
    : CLASSIFICATION.CAPABILITY;

  const confidence = confMatch
    ? Math.round(Math.max(0, Math.min(1, parseFloat(confMatch[1]))) * 100) / 100
    : 0.70;

  const reasoning = reasonMatch
    ? reasonMatch[1].trim()
    : `LLM classified "${name}" as ${classification}`;

  return {
    classification,
    confidence,
    method: 'llm',
    reasoning,
    isSolution: classification === CLASSIFICATION.SOLUTION,
  };
}

// ─── Unified Detection Pipeline ───────────────────────────────────────────────

/**
 * Detect whether a component is a solution or capability using the two-tier
 * detection pipeline: naming conventions first, LLM fallback if uncertain.
 *
 * @param {string} name       - Component name to classify
 * @param {Object} [options]
 * @param {string} [options.context]  - Additional context about the component
 * @param {function(string): Promise<string>} [options.llmCall]
 *   LLM call function for fallback classification. If not provided and naming
 *   heuristics are uncertain, returns the uncertain naming result.
 * @returns {Promise<SolutionDetectionResult>}
 */
export async function detectSolution(name, options = {}) {
  const TOOL = 'detectSolution';

  // Tier 1: Naming convention heuristics
  const namingResult = classifySolutionNaming(name, options);

  logDebug(TOOL, `Naming result for "${name}": ${namingResult.classification} (confidence=${namingResult.confidence})`);

  // If confidence >= threshold, return immediately (no LLM cost)
  if (namingResult.confidence >= NAMING_CONFIDENCE_THRESHOLD) {
    logDebug(TOOL, `High-confidence naming match for "${name}" — skipping LLM fallback`);
    return namingResult;
  }

  // Tier 2: LLM fallback (if llmCall available)
  if (typeof options.llmCall !== 'function') {
    logDebug(TOOL, `No llmCall provided for "${name}" — returning uncertain naming result`);
    return namingResult;
  }

  try {
    const llmResult = await classifySolutionLLM(name, options.llmCall, options);

    // Combine naming and LLM signals for higher confidence
    // If both agree, boost confidence; if they disagree, trust LLM but lower confidence
    if (namingResult.classification === llmResult.classification) {
      // Agreement: boost confidence (average + bonus)
      const combined = Math.round(
        Math.min(0.98, (namingResult.confidence + llmResult.confidence) / 2 + 0.10) * 100
      ) / 100;

      return {
        classification: llmResult.classification,
        confidence: combined,
        method: 'naming+llm',
        reasoning: `${llmResult.reasoning} (naming heuristics agree: ${namingResult.reasoning})`,
        isSolution: llmResult.isSolution,
      };
    }

    // Disagreement: trust LLM (more semantically aware), but signal lower confidence
    const disagreementConfidence = Math.round(
      Math.max(0.50, llmResult.confidence - 0.10) * 100
    ) / 100;

    return {
      classification: llmResult.classification,
      confidence: disagreementConfidence,
      method: 'naming+llm',
      reasoning: `LLM overrides naming heuristics: ${llmResult.reasoning} (naming said: ${namingResult.classification})`,
      isSolution: llmResult.isSolution,
    };
  } catch (err) {
    // LLM failed — fall back to naming result
    logDebug(TOOL, `LLM fallback failed for "${name}": ${err.message} — using naming result`);
    return {
      ...namingResult,
      reasoning: `${namingResult.reasoning} (LLM fallback unavailable: ${err.message})`,
    };
  }
}

// ─── Routing Mode ─────────────────────────────────────────────────────────────

/**
 * Get the current evaluation routing mode from environment.
 *
 * @returns {'exclusive'|'parallel'} Routing mode
 */
export function getRoutingMode() {
  const mode = (process.env.WARDLEY_EVAL_MODE || 'exclusive').trim().toLowerCase();
  return mode === 'parallel' ? 'parallel' : 'exclusive';
}

// ─── Exports for Testing ──────────────────────────────────────────────────────

export { NAMING_CONFIDENCE_THRESHOLD, KNOWN_SOLUTIONS };

// ─── Self-test ────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  console.log('=== detect-solution.mjs self-test ===\n');

  // ── Test 1: Known solutions ──────────────────────────────────────────
  console.log('--- Test 1: Known solutions (naming) ---');
  const knownSolutions = ['Kubernetes', 'Salesforce', 'PostgreSQL', 'Docker', 'React', 'Terraform'];
  for (const name of knownSolutions) {
    const result = classifySolutionNaming(name);
    const ok = result.classification === 'solution' && result.confidence >= 0.90;
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}: ${result.classification} (${result.confidence}) — ${result.reasoning}`);
  }

  // ── Test 2: Known capabilities ───────────────────────────────────────
  console.log('\n--- Test 2: Capabilities (naming) ---');
  const knownCapabilities = [
    'container orchestration',
    'manage customer relationships',
    'how to manage IT services',
    'data storage',
    'authentication',
    'monitoring',
  ];
  for (const name of knownCapabilities) {
    const result = classifySolutionNaming(name);
    const ok = result.classification === 'capability';
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}: ${result.classification} (${result.confidence}) — ${result.reasoning}`);
  }

  // ── Test 3: Ambiguous cases ──────────────────────────────────────────
  console.log('\n--- Test 3: Ambiguous cases (naming) ---');
  const ambiguous = ['ERP', 'CRM', 'LLM', 'API', 'SDK'];
  for (const name of ambiguous) {
    const result = classifySolutionNaming(name);
    console.log(`  ? ${name}: ${result.classification} (${result.confidence}) — ${result.reasoning}`);
    console.log(`    → Would need LLM fallback: ${result.confidence < NAMING_CONFIDENCE_THRESHOLD}`);
  }

  // ── Test 4: LLM response parsing ────────────────────────────────────
  console.log('\n--- Test 4: LLM response parsing ---');
  const parseTests = [
    {
      response: 'classification=SOLUTION\nconfidence=0.95\nreasoning=Kubernetes is a specific container orchestration platform',
      expectedClass: 'solution',
      expectedConf: 0.95,
    },
    {
      response: 'classification=CAPABILITY\nconfidence=0.88\nreasoning=Container orchestration is an abstract capability',
      expectedClass: 'capability',
      expectedConf: 0.88,
    },
    {
      response: 'Some preamble\nclassification=SOLUTION\nconfidence=0.90\nreasoning=It is a product',
      expectedClass: 'solution',
      expectedConf: 0.90,
    },
    {
      response: 'This is a SOLUTION because...',
      expectedClass: 'solution',
      expectedConf: 0.60,
    },
    {
      response: 'Completely unparseable response',
      expectedClass: 'capability',
      expectedConf: 0.40,
    },
  ];
  for (const pt of parseTests) {
    const result = parseLLMClassificationResponse(pt.response, 'test');
    const ok = result.classification === pt.expectedClass && result.confidence === pt.expectedConf;
    console.log(`  ${ok ? '\u2713' : '\u2717'} "${pt.response.substring(0, 50)}..." → ${result.classification} (${result.confidence})`);
    if (!ok) {
      console.log(`    Expected: ${pt.expectedClass} (${pt.expectedConf}), Got: ${result.classification} (${result.confidence})`);
    }
  }

  // ── Test 5: Routing mode ────────────────────────────────────────────
  console.log('\n--- Test 5: Routing mode ---');
  const originalMode = process.env.WARDLEY_EVAL_MODE;
  process.env.WARDLEY_EVAL_MODE = 'exclusive';
  console.log(`  Exclusive: ${getRoutingMode()}`);
  process.env.WARDLEY_EVAL_MODE = 'parallel';
  console.log(`  Parallel: ${getRoutingMode()}`);
  delete process.env.WARDLEY_EVAL_MODE;
  console.log(`  Default: ${getRoutingMode()}`);
  if (originalMode) process.env.WARDLEY_EVAL_MODE = originalMode;

  // ── Test 6: detectSolution pipeline (no LLM) ───────────────────────
  console.log('\n--- Test 6: Full pipeline (no LLM) ---');
  const pipelineTests = [
    { name: 'Kubernetes', expected: 'solution' },
    { name: 'container orchestration', expected: 'capability' },
    { name: 'ERP', expected: null },  // null = ambiguous, any is ok
  ];
  for (const pt of pipelineTests) {
    const result = await detectSolution(pt.name);
    const ok = pt.expected === null || result.classification === pt.expected;
    console.log(`  ${ok ? '\u2713' : '\u2717'} ${pt.name}: ${result.classification} (${result.confidence}, method=${result.method})`);
  }

  // ── Test 7: Context influence ───────────────────────────────────────
  console.log('\n--- Test 7: Context influence ---');
  const ctxResult1 = classifySolutionNaming('MyTool', { context: 'a vendor product for deployment' });
  console.log(`  MyTool (product context): ${ctxResult1.classification} (${ctxResult1.confidence})`);
  const ctxResult2 = classifySolutionNaming('MyTool', { context: 'a capability for process management' });
  console.log(`  MyTool (capability context): ${ctxResult2.classification} (${ctxResult2.confidence})`);

  console.log('\n=== self-test complete ===');
}
