// Zod safe-parse + formatted error helper.
//
// Centralises the pattern used by recipe-loader, llm-config loader, and
// prompts-config loader for parsing a JSON config and throwing a readable
// validation error when the shape does not match. The thrown message has
// the exact same layout as the inline pre-extraction code so existing
// tests and downstream consumers remain unaffected.

import type { ZodType } from 'zod';

/**
 * Run `schema.safeParse(value)` and either return the parsed data or throw
 * an Error with a formatted multi-line message:
 *
 *     {contextLabel} failed validation:
 *       - {path}: {message}
 *       - {path}: {message}
 *
 * `contextLabel` should describe the source being validated (e.g.
 * ``Recipe ${path}`` or ``LLM config at ${path}``); it is rendered verbatim
 * before the trailing " failed validation:".
 */
export function validateOrThrow<T>(
  schema: ZodType<T>,
  value: unknown,
  contextLabel: string,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`${contextLabel} failed validation:\n${details}`);
  }
  return result.data;
}
