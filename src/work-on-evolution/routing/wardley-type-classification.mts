// Wardley Component Type Classification
//
// Wardley Maps distinguish 4 types of components along the value chain:
//   - Activity:   things you DO (manage, process, deliver, store, compute...)
//   - Practice:   HOW you do things (methodologies, standards, frameworks, approaches)
//   - Data:       information, metrics, records, signals, datasets
//   - Knowledge:  expertise, skills, understanding, models, algorithms
//
// This classification is informative metadata only -- it does NOT change routing
// or evaluation logic. It enriches the output for Wardley Map construction.

import { KNOWN_CAPABILITIES } from '../../lib/known-dictionaries.mjs';

/** @typedef {'activity'|'practice'|'data'|'knowledge'} WardleyComponentType */

/** Wardley component type constants */
export const WARDLEY_TYPE = {
  ACTIVITY: 'activity',
  PRACTICE: 'practice',
  DATA: 'data',
  KNOWLEDGE: 'knowledge',
};

/**
 * Heuristic patterns for Wardley component type classification.
 * Applied when the type isn't already known from dictionary lookup.
 */
export const WARDLEY_TYPE_PATTERNS = {
  activity: [
    // Starts with activity verb
    /^(manage|orchestrate|process|deliver|store|compute|deploy|build|create|monitor|serve|route|host|run|handle|track|schedule|encrypt|collect|aggregate|index|backup|restore|notify|moderate|operate|execute|provision|scale|configure|maintain|administer|integrate|automate|authenticate|authorize|balance|cache|search|stream|replicate)\b/i,
    // Gerund + noun (activity phrasing): "load balancing", "event streaming"
    /^\w+ing\s+\w+/i,
    // "management" suffix
    /\bmanagement$/i,
    // Common activity suffixes
    /\b(processing|delivery|storage|hosting|computing|deployment|provisioning|scheduling|orchestration|brokering|streaming|balancing|routing|caching|archiving)\b$/i,
  ],
  practice: [
    // "how to" prefix
    /^how\s+to\b/i,
    // Known practice patterns
    /\b(methodology|framework|standard|best.?practice|process\s+model|approach|discipline|principle|pattern|governance|compliance|certification)\b/i,
    // -ops family (DevOps, MLOps, etc.)
    /ops$/i,
    // "as code" patterns (infrastructure as code, etc.)
    /\bas\s+(code|a\s+service)$/i,
    // Continuous * (CI/CD family)
    /^continuous\s+/i,
    // Agile / Lean / Six Sigma type names
    /\b(agile|lean|six\s+sigma|kaizen|kanban|scrum|xp|tdd|bdd|ddd|sre|itil|cobit|togaf|safe|prince2)\b/i,
  ],
  data: [
    // Explicit data words
    /\b(data|dataset|database|record|metric|signal|log|index|catalog|registry|inventory|report|dashboard|feed|telemetry|trace|event\s+data|time.?series|metadata)\b/i,
    // Information / intelligence terms
    /\b(information|intelligence|insight|analytics\s+data|sensor\s+data)\b/i,
  ],
  knowledge: [
    // Expertise / skills / know-how
    /\b(expertise|skill|know-?how|knowledge|competence|proficiency|understanding|literacy|fluency)\b/i,
    // ML / AI models and algorithms
    /\b(model|algorithm|neural\s+network|machine\s+learning|deep\s+learning|natural\s+language|computer\s+vision|artificial\s+intelligence|generative\s+ai)\b/i,
    // Research / science domains
    /\b(research|science|theory|taxonomy|ontology|heuristic)\b/i,
  ],
};

/**
 * Classify a Wardley component into one of the 4 types:
 * activity, practice, data, or knowledge.
 *
 * Uses a layered approach:
 *   1. If the component was matched in KNOWN_CAPABILITIES and has a `nature` field, use it directly
 *   2. If the component was matched in KNOWN_SOLUTIONS, infer from category
 *   3. Apply heuristic patterns on the component name and description
 *   4. Default to 'activity' (most common in Wardley Maps)
 *
 * @param {string} name - Component name
 * @param {Object} [options]
 * @param {string} [options.description] - Component description for contextual inference
 * @param {string} [options.nature] - Pre-existing nature from detection (e.g. from KNOWN_CAPABILITIES)
 * @param {string} [options.category] - Category from KNOWN_SOLUTIONS
 * @returns {{ wardleyType: WardleyComponentType, confidence: number, reason: string }}
 */
export function classifyWardleyType(name: string, options: any = {}) {
  const trimmed = (name || '').trim();

  // Layer 1: Use pre-existing nature from dictionary lookup
  if (options.nature) {
    const validTypes = new Set(Object.values(WARDLEY_TYPE));
    if (validTypes.has(options.nature)) {
      return {
        wardleyType: options.nature,
        confidence: 0.95,
        reason: `dictionary match (nature: ${options.nature})`,
      };
    }
  }

  // Layer 2: Check KNOWN_CAPABILITIES directly for nature
  const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
  const capMatch = KNOWN_CAPABILITIES.get(normalized);
  if (capMatch?.nature) {
    return {
      wardleyType: capMatch.nature,
      confidence: 0.95,
      reason: `known capability "${capMatch.canonical}" (nature: ${capMatch.nature})`,
    };
  }

  // Layer 3: Infer from solution category (most solutions enable activities)
  if (options.category) {
    const cat = options.category.toLowerCase();
    if (/\b(data|database|analytics|warehouse|lake)\b/.test(cat)) {
      return { wardleyType: WARDLEY_TYPE.DATA, confidence: 0.70, reason: `solution category "${options.category}" suggests data` };
    }
    if (/\b(framework|methodology|standard|practice)\b/.test(cat)) {
      return { wardleyType: WARDLEY_TYPE.PRACTICE, confidence: 0.70, reason: `solution category "${options.category}" suggests practice` };
    }
    if (/\b(ai|ml|model|algorithm|language)\b/.test(cat)) {
      return { wardleyType: WARDLEY_TYPE.KNOWLEDGE, confidence: 0.70, reason: `solution category "${options.category}" suggests knowledge` };
    }
    // Most solution categories (CRM, ERP, platform, etc.) map to activity
    return { wardleyType: WARDLEY_TYPE.ACTIVITY, confidence: 0.60, reason: `solution category "${options.category}" defaults to activity` };
  }

  // Layer 4: Pattern-based heuristic on name + description
  const textToCheck = `${trimmed} ${options.description || ''}`.trim();
  const scores: Record<string, number> = { activity: 0, practice: 0, data: 0, knowledge: 0 };

  for (const [type, patterns] of Object.entries(WARDLEY_TYPE_PATTERNS) as [string, RegExp[]][]) {
    for (const pattern of patterns) {
      if (pattern.test(textToCheck)) {
        scores[type] += 1;
      }
    }
  }

  const maxScore = Math.max(...Object.values(scores));
  if (maxScore > 0) {
    const bestType = Object.entries(scores).find(([, s]) => s === maxScore)[0];
    // Confidence: higher when one type clearly dominates
    const totalMatches = Object.values(scores).reduce((a, b) => a + b, 0);
    const dominance = maxScore / totalMatches;
    const confidence = Math.round(Math.min(0.90, 0.50 + dominance * 0.40) * 100) / 100;

    return {
      wardleyType: bestType,
      confidence,
      reason: `pattern match (${maxScore} indicator(s) for ${bestType})`,
    };
  }

  // Layer 5: Default to activity (most common component type in Wardley Maps)
  return {
    wardleyType: WARDLEY_TYPE.ACTIVITY,
    confidence: 0.40,
    reason: 'default classification (no strong signals detected)',
  };
}
