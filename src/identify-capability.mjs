// Identify the true underlying capability or need behind a component label.
//
// Reusable module: can be called by any strategy or tool that needs to
// decode technical solution names (CRM, ERP, Kubernetes…) into the
// capability they serve, classified by type and nature.

const CAPABILITY_IDENTIFICATION_PROMPT = `You are an expert in Wardley Mapping and business capability modeling.

Given a component label and its context, identify the TRUE underlying capability or need.

Component types in Wardley Mapping:
- anchor: the user need at the top of the value chain
- capability: an activity, practice, knowledge, or data component that fulfills a need
- pipeline: a set of components at different evolution stages serving the same capability
- market: a competitive space where multiple providers exist
- ecosystem: an interconnected system of components

For capability/need components, identify the nature using these naming conventions:
- Activité (activite): expression qui démarre par un verbe à l'infinitif
    ex: "Gérer la relation client", "Orchestrer des conteneurs", "Brasser de la bière"
- Pratique (pratique): expression qui démarre par "manière de..."
    ex: "manière de gérer un projet", "manière de conduire une voiture"
- Connaissance (connaissance): expression qui démarre par "savoir-faire..." ou "savoir-être..."
    ex: "savoir-faire en soudure", "savoir-être managérial"
- Donnée (donnee): le titre est descriptif de la donnée elle-même
    ex: "température ambiante", "taux de conversion", "coordonnées GPS"

IMPORTANT: Many component labels are technical solution names, not capabilities.
You must look BEHIND the label to find the underlying capability and reformulate it
following the naming convention of its nature.
Examples:
  - "CRM" → type=capability, nature=activite, capability=Gérer la relation client
  - "ITIL" → type=capability, nature=pratique, capability=manière de gérer les services informatiques
  - "Kubernetes" → type=capability, nature=activite, capability=Orchestrer des conteneurs
  - "Data Warehouse" → type=capability, nature=donnee, capability=données décisionnelles consolidées
  - "Coaching" → type=capability, nature=connaissance, capability=savoir-être d'accompagnement

Component: {{component}}
Context: {{context}}

MANDATORY FORMAT: exactly three lines at the end, no additional text after them:
type=<anchor|capability|pipeline|market|ecosystem>
nature=<activite|pratique|connaissance|donnee|none>
capability=<the underlying capability described following its nature's naming convention>
confidence=X.XX (a number between 0 and 1 reflecting your confidence in this identification)`;


/**
 * Parse LLM capability identification response.
 * @param {string} text
 * @returns {{ type: string, nature: string, capability: string, confidence: string }}
 */
export function parseCapabilityResponse(text) {
  const typeMatch = text.match(/type[:\s=]*(\S+)/i);
  const natureMatch = text.match(/nature[:\s=]*(\S+)/i);
  const capMatch = text.match(/capability[:\s=]*(.*)/i);
  const confidenceMatch = text.match(/confidence[:\s=]*(.*)/i);

  if (!typeMatch || !capMatch) {
    throw new Error(`identifyCapability: could not parse LLM response: ${text.slice(0, 200)}`);
  }

  return {
    type: typeMatch[1].trim().toLowerCase(),
    nature: natureMatch ? natureMatch[1].trim().toLowerCase() : 'none',
    capability: capMatch[1].trim(),
    confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
  };
}

/**
 * Identify the true underlying capability or need behind a component label.
 *
 * @param {{ name: string, description?: string, context?: string }} component
 * @param {function(string): Promise<string>} llmCall
 * @returns {Promise<{ type: string, nature: string, capability: string }>}
 */
export async function identifyCapability(component, llmCall) {
  const prompt = CAPABILITY_IDENTIFICATION_PROMPT
    .replace('{{component}}', component.name || '')
    .replace('{{context}}', component.description || component.context || '');

  const response = await llmCall(prompt);
  return parseCapabilityResponse(response);
}
