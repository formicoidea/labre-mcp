// Zod schema for the unified LLM configuration file (llm.config.json).
//
// Every MCP strategy declares independently which provider it uses
// (agent-sdk runtime or http-api) and its per-call parameters.
// Secrets stay in .env — the JSON only references env var names via apiKeyEnv.

import { z } from 'zod';

export const ProviderKindSchema = z.enum(['agent-sdk', 'http-api', 'copilot-sdk']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  kind: ProviderKindSchema,
  baseUrl: z.string().url().optional(),
  // HTTP API providers reference an API key env var name (e.g. OPENCODE_API_KEY).
  apiKeyEnv: z.string().min(1).optional(),
  // GitHub Copilot SDK references a GitHub auth env var name (e.g. COPILOT_GITHUB_TOKEN).
  // Kept distinct from apiKeyEnv: a GitHub token is not an API key, and the
  // Copilot SDK also falls back to `gh auth login` credentials when unset.
  authEnv: z.string().min(1).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const StrategyConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topLogprobs: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  systemPrompt: z.string().optional(),
});
export type StrategyConfig = z.infer<typeof StrategyConfigSchema>;

export const LLMConfigSchema = z.object({
  defaultProvider: z.string().min(1),
  providers: z.record(z.string(), ProviderConfigSchema),
  strategies: z.record(z.string(), StrategyConfigSchema),
}).superRefine((cfg, ctx) => {
  if (cfg.providers[cfg.defaultProvider] === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `defaultProvider "${cfg.defaultProvider}" is not declared in providers`,
      path: ['defaultProvider'],
    });
  }
  for (const [stratId, strat] of Object.entries(cfg.strategies)) {
    if (cfg.providers[strat.provider] === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `Strategy "${stratId}" references unknown provider "${strat.provider}"`,
        path: ['strategies', stratId, 'provider'],
      });
    }
  }
});
export type LLMConfig = z.infer<typeof LLMConfigSchema>;
