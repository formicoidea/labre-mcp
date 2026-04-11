// Identify the true underlying capability or need behind a component label.
//
// Reusable module: can be called by any strategy or tool that needs to
// decode technical solution names (CRM, ERP, Kubernetes…) into the
// capability they serve, classified by type and nature.
//
// Also exposes an MCP tool definition (IDENTIFY_CAPABILITY_TOOL) and
// handler (handleIdentifyCapability) for direct invocation via MCP clients.

import { createLLMCall } from '../lib/llm/llm-call.mjs';
import { logDebug } from '../lib/mcp-notifications.mjs';

const ELIGIBLE_TYPES = new Set(['component', 'pipeline']);

const CAPABILITY_IDENTIFICATION_PROMPT = `You are an expert in Wardley Mapping and business capability modeling.

Given a component label and its context, identify the TRUE underlying capability or need.

Component types in Wardley Mapping:
- anchor: the stakeholder who reaps the benefits of the value chain
- component: an activity, practice, knowledge, or data component that fulfills a need
- pipeline: a set of components at different evolution stages serving the same capability
- market: a node symbolizing a competitive crossroad where multiple providers exist
- ecosystem: an interconnected system of components

IMPORTANT: Many component labels are technical solution names, not capabilities.
You must look BEHIND the label to find the underlying capability.
The essence of capability transcends time, innovation after innovation.

Component: {{component}}
Context: {{context}}

For component and pipeline types, identify the nature and reformulate the label using these naming conventions:
- Activity: a phrase that begins with an infinitive verb
    ex: “Manage customer relationships,” “Orchestrate containers,” “Brew beer”
- Practice: a phrase that begins with “how to...”
    ex: “how to manage a project”, “how to drive a car”
- Knowledge: a phrase that begins with “technical expertise...” or “interpersonal skills...”
    e.g., “welding know-how,” “managerial interpersonal skills”
- Data: the title describes the data itself
    e.g., “ambient temperature,” “conversion rate,” “GPS coordinates”

For anchor, market, or ecosystem types, set nature=none and keep the original label as capability.

MANDATORY FORMAT: exactly five lines at the end, no additional text after them:
type=<anchor|component|pipeline|market|ecosystem>
nature=<activity|practice|knowledge|data|none>
capability=<the underlying capability described following its nature's naming convention>
confidence=X.XX (a number between 0 and 1 reflecting your confidence in this identification)
justification=<brief explanation of why you assigned this confidence level>

Examples:
  - “CRM” → type=component, nature=activity, capability=”Manage customer relationships”
  - “ITIL” → type=component, nature=practice, capability=”how to manage IT services”
  - “Kubernetes” → type=component, nature=activity, capability=”Orchestrate containers”
  - “Data Warehouse” → type=component, nature=data, capability=”consolidated business intelligence data”
  - “Coaching” → type=component, nature=knowledge, capability=”interpersonal skills for support”`
;


/**
 * Parse LLM capability identification response.
 * Input type (from OWM DSL) always takes priority over LLM-estimated type.
 * @param {string} text - Raw LLM response
 * @param {{ name: string, type?: string, context?: string }} component - Input component
 * @returns {{ type: string, nature: string, capability: string, confidence: number, justification: string, context: string, name: string }}
 */
export function parseCapabilityResponse(text, component) {
  const typeMatch = text.match(/^type=(\S+)/mi);
  const natureMatch = text.match(/^nature=(\S+)/mi);
  const capMatch = text.match(/^capability=(.*)/mi);
  const confidenceMatch = text.match(/^confidence=(.*)/mi);
  const justMatch = text.match(/^justification=(.*)/mi);

  if (!capMatch) {
    throw new Error(`identifyCapability: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  const llmType = typeMatch ? typeMatch[1].trim().toLowerCase() : 'component';

  return {
    type: component.type || llmType,
    nature: natureMatch ? natureMatch[1].trim().toLowerCase() : 'none',
    capability: capMatch[1].trim(),
    context: component.context || '',
    name: component.name || '',
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
    justification: justMatch ? justMatch[1].trim() : '',
  };
}

/**
 * Identify the true underlying capability or need behind a component label.
 *
 * When type is provided (from OWM DSL):
 *   - anchor/market/ecosystem → skip immediately, no LLM call
 *   - component/pipeline → LLM identifies nature/capability, input type is authoritative
 *
 * When type is absent:
 *   - LLM estimates type + nature + capability (no penalty)
 *
 * @param {{ name: string, type?: string, description?: string, context?: string }} component
 * @param {function(string): Promise<string>} llmCall
 * @returns {Promise<{ type: string, nature: string, capability: string, confidence: number, justification: string }>}
 */
export async function identifyCapability(component, llmCall) {
  // When type is known and non-eligible, skip immediately
  if (component.type && !ELIGIBLE_TYPES.has(component.type)) {
    return {
      type: component.type,
      nature: 'none',
      capability: component.name || '',
      context: component.context || '',
      name: component.name || '',
      confidence: 1,
      justification: `Type "${component.type}" is not eligible for capability identification (only component and pipeline are)`,
      skipped: true,
    };
  }

  const prompt = CAPABILITY_IDENTIFICATION_PROMPT
    .replace('{{component}}', component.name || '')
    .replace('{{context}}', component.description || component.context || '');

  const response = await llmCall(prompt);
  const result = parseCapabilityResponse(response, component);

  // When type was not provided, check if LLM-estimated type is non-eligible
  if (!component.type && !ELIGIBLE_TYPES.has(result.type)) {
    return {
      ...result,
      nature: 'none',
      capability: component.name || '',
      skipped: true,
    };
  }

  return result;
}

// ─── Lazy LLM Singleton ────────────────────────────────────────────────────

let _llmCall = null;
function getLLMCall() {
  if (!_llmCall) {
    const model = process.env.WARDLEY_LLM_MODEL || 'claude-sonnet-4-6';
    logDebug('identifyCapability', `LLM backend: Agent SDK, model="${model}"`);
    _llmCall = createLLMCall({
      model,
      effort: 'high',
      maxBudgetUsd: 0.10,
    });
  }
  return _llmCall;
}

// ─── MCP Tool Definition ───────────────────────────────────────────────────

export const IDENTIFY_CAPABILITY_TOOL = {
  name: 'identifyCapability',
  description:
    'Identify the true underlying capability or need behind a Wardley Map component label. ' +
    'Decodes technical solution names (CRM, ERP, Kubernetes...) into the capability they serve, ' +
    'classified by nature (activity, practice, knowledge, data). ' +
    'Only works for component and pipeline types — other types (anchor, market, ecosystem) are returned as-is.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Component name or label (e.g. "CRM", "Kubernetes", "Data Warehouse")',
      },
      type: {
        type: 'string',
        enum: ['anchor', 'component', 'pipeline', 'market', 'ecosystem'],
        description: 'Component type from the OWM DSL. If provided, takes priority over LLM estimation. Non-eligible types (anchor, market, ecosystem) are skipped immediately.',
      },
      description: {
        type: 'string',
        description: 'Free-text description or business context for the component',
      },
      context: {
        type: 'string',
        description: 'Additional context about how the component is used in the value chain',
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

export async function handleIdentifyCapability(args) {
  if (!args?.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }

  const component = {
    name: args.name.trim(),
    ...(args.type && { type: args.type }),
    ...(args.description && { description: args.description.trim() }),
    ...(args.context && { context: args.context.trim() }),
  };

  return identifyCapability(component, getLLMCall());
}
