// Conversation session types
//
// Used by src/session/conversation-session.mts to manage multi-turn
// evolution estimation flows.

export interface SessionState {
  name: string | null;
  description: string | null;
  space: string | null;
  certitude: number | null;
  ubiquity: number | null;
  wonder: number | null;
  build: number | null;
  operate: number | null;
  usage: number | null;
  sector: string | null;
  maturitySignals: string | null;
  marketDynamics: string | null;
  adoptionPattern: string | null;
  strategy: string;
  componentType: string | null;
  componentTypeConfidence: number | null;
  componentTypeMethod: string | null;
  solutionContext: string | null;
  phase: string;
  /** History of phase transitions / debug messages (mutable log) */
  history?: string[];
  /** Loose extension: phase-specific fields and gathered free-text inputs */
  [key: string]: unknown;
}

export interface SessionExchange {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: number;
}
