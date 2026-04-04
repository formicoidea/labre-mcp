// Identify the true underlying capability or need behind a component label.
//
// Reusable module: can be called by any strategy or tool that needs to
// decode technical solution names (CRM, ERP, Kubernetes…) into the
// capability they serve, classified by type and nature.
//
// Also exposes an MCP tool definition (IDENTIFY_CAPABILITY_TOOL) and
// handler (handleIdentifyCapability) for direct invocation via MCP clients.

import { createLLMCall } from './llm-call.mjs';
import { logDebug } from './mcp-notifications.mjs';

const ELIGIBLE_TYPES = new Set(['component', 'pipeline']);

const CAPABILITY_IDENTIFICATION_PROMPT = `You are an expert in Wardley Mapping and business capability modeling.

Given a component label and its context, identify the TRUE underlying capability or need.

IMPORTANT: Many component labels are technical solution names, not capabilities.
You must look BEHIND the label to find the underlying capability.
The essence of capability transcends time, innovation after innovation.

Component: {{component}}
Context: {{context}}

Identify the nature of the capability and reformulate the label using these naming conventions:
- Activity: a phrase that begins with an infinitive verb
    ex: “Manage customer relationships,” “Orchestrate containers,” “Brew beer”
- Practice: a phrase that begins with “how to...”
    ex: “how to manage a project”, “how to drive a car”
- Knowledge: a phrase that begins with “technical expertise...” or “interpersonal skills...”
    e.g., “welding know-how,” “managerial interpersonal skills”
- Data: the title describes the data itself
    e.g., “ambient temperature,” “conversion rate,” “GPS coordinates”

MANDATORY FORMAT: exactly three lines at the end, no additional text after them:
nature=<activity|practice|knowledge|data>
capability=<the underlying capability described following its nature's naming convention>
confidence=X.XX (a number between 0 and 1 reflecting your confidence in this identification)

Examples:
  - “CRM” → nature=activity, capability=”Manage customer relationships”
  - “ITIL” → nature=practice, capability=”how to manage IT services”
  - “Kubernetes” → nature=activity, capability=”Orchestrate containers”
  - “Data Warehouse” → nature=data, capability=”consolidated business intelligence data”
  - “Coaching” → nature=knowledge, capability=”interpersonal skills for support”`
;


/**
 * Parse LLM capability identification response.
 * @param {string} text - Raw LLM response
 * @param {{ name: string, type?: string, context?: string }} component - Input component (type from OWM DSL)
 * @returns {{ type: string, nature: string, capability: string, confidence: number, context: string, name: string }}
 */
export function parseCapabilityResponse(text, component) {
  const natureMatch = text.match(/^nature=(\S+)/mi);
  const capMatch = text.match(/^capability=(.*)/mi);
  const confidenceMatch = text.match(/^confidence=(.*)/mi);

  if (!capMatch) {
    throw new Error(`identifyCapability: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    type: component.type || 'component',
    nature: natureMatch ? natureMatch[1].trim().toLowerCase() : 'none',
    capability: capMatch[1].trim(),
    context: component.context || '',
    name: component.name || '',
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
  };
}

/**
 * Identify the true underlying capability or need behind a component label.
 *
 * Only eligible for component and pipeline types. Other types (anchor, market,
 * ecosystem) are returned as-is with nature='none'.
 *
 * @param {{ name: string, type?: string, description?: string, context?: string }} component
 * @param {function(string): Promise<string>} llmCall
 * @returns {Promise<{ type: string, nature: string, capability: string, confidence: number }>}
 */
export async function identifyCapability(component, llmCall) {
  const type = component.type || 'component';

  if (!ELIGIBLE_TYPES.has(type)) {
    return {
      type,
      nature: 'none',
      capability: component.name || '',
      context: component.context || '',
      name: component.name || '',
      confidence: 1,
      skipped: true,
      reason: `Type "${type}" is not eligible for capability identification (only component and pipeline are)`,
    };
  }

  const prompt = CAPABILITY_IDENTIFICATION_PROMPT
    .replace('{{component}}', component.name || '')
    .replace('{{context}}', component.description || component.context || '');

  const response = await llmCall(prompt);
  return parseCapabilityResponse(response, component);
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
        description: 'Component type from the OWM DSL',
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
    required: ['name', 'type'],
    additionalProperties: false,
  },
};

export async function handleIdentifyCapability(args) {
  if (!args?.name || typeof args.name !== 'string' || args.name.trim().length === 0) {
    throw new Error('Required parameter "name" must be a non-empty string');
  }
  if (!args?.type) {
    throw new Error('Required parameter "type" must be one of: anchor, component, pipeline, market, ecosystem');
  }

  const component = {
    name: args.name.trim(),
    type: args.type,
    ...(args.description && { description: args.description.trim() }),
    ...(args.context && { context: args.context.trim() }),
  };

  return identifyCapability(component, getLLMCall());
}
