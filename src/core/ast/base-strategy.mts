// Generic base for every strategy in labre-mcp.
// Concrete strategies live under src/frameworks/<framework>/<tool>/<command>/<subdomain>/<name>.mts
// and declare their identity via the static `method` getter following the
// 5-segment pattern {framework}:{tool}:{command}:{subdomain}:{strategy} (ARCH-03).

import { z } from "zod";
import type { RequestContext } from "../context/request-context.mjs";

// Canonical 5-segment methodId pattern (ARCH-03):
//   {framework}:{tool}:{command}:{subdomain}:{strategy}
// Each segment starts with a lowercase letter and may contain lowercase
// alphanumerics or dashes. Anchored end-to-end.
export const METHOD_ID_5_SEGMENT_REGEX =
  /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*){4}$/;

// Zod schema fragment that enforces the 5-segment shape on any methodId
// field stored inside an AST or a recipe definition.
export const methodIdSchema = z
  .string()
  .regex(
    METHOD_ID_5_SEGMENT_REGEX,
    'methodId must be 5 colon-separated segments {framework}:{tool}:{command}:{subdomain}:{strategy}',
  );

export interface StrategyResult<TResult = unknown> {
  signals: Array<{
    name: string;
    // any: signal value type is open by design — strategies declare their own
    value: unknown;
    source:
      | "user-input"
      | "web-search"
      | "cpc-database"
      | "llm-internal"
      | "computed";
    capturedAt: string;
  }>;
  reasoning: Array<{
    by: string;
    text: string;
    promptTokens?: number;
    completionTokens?: number;
  }>;
  insights: Array<{
    text: string;
    by: string;
    type:
      | "historical-context"
      | "comparable"
      | "trajectory"
      | "cluster"
      | "other";
    confidence?: number;
  }>;
  result: TResult;
}

export abstract class BaseStrategy<TInput = unknown, TResult = unknown> {
  // Each concrete subclass overrides this to return its 5-segment methodId.
  static get method(): string {
    throw new Error(
      "BaseStrategy.method must be overridden by the subclass with a 5-segment methodId",
    );
  }

  abstract evaluate(
    input: TInput,
    context: RequestContext,
  ): Promise<StrategyResult<TResult>>;
}
