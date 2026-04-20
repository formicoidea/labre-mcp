// Substitute {{var}} placeholders in a template string.
//
// Replaces *all* occurrences of each placeholder (global regex), unlike the
// chained `.replace('{{x}}', v)` pattern which only replaces the first.
// In current templates no variable appears twice, so behavior is equivalent —
// but the global regex is the safer default going forward.
//
// Missing variables are replaced with an empty string.

export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
