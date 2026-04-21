// Manual spike — validate the Copilot SDK "voie B" path (prompt -> free-form
// text -> JSON.parse -> Zod validation) before wiring the provider into the
// registry. Run on a machine that has a GitHub Copilot subscription.
//
// Prerequisites:
//   1. `gh auth login` OR set COPILOT_GITHUB_TOKEN to a PAT with Copilot access
//   2. The Copilot CLI is available (the SDK spawns it as a JSON-RPC subprocess);
//      install via `npm i -g @github/copilot` if missing.
//
// Usage:
//   npx tsx scripts/spike-copilot-sdk.mts
//   SPIKE_MODEL=claude-sonnet-4-6 npx tsx scripts/spike-copilot-sdk.mts
//   COPILOT_GITHUB_TOKEN=ghp_... npx tsx scripts/spike-copilot-sdk.mts
//
// Gate (as per plan CP1): if the Zod validation fails repeatedly or latency is
// wildly worse than the Claude Agent SDK path, reconsider adopting defineTool
// instead of voie B.

// any: Copilot SDK public preview ships without exported type-level names for
// session events; we type the fields we actually touch and keep the rest loose.
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { z } from 'zod';

const SpikeSchema = z.object({
  component: z.string(),
  estimated_phase: z.enum(['phase1', 'phase2', 'phase3', 'phase4']),
  confidence: z.number().min(0).max(1),
  justification: z.string().min(1),
});
type Spike = z.infer<typeof SpikeSchema>;

const jsonSchema = {
  type: 'object',
  required: ['component', 'estimated_phase', 'confidence', 'justification'],
  properties: {
    component: { type: 'string' },
    estimated_phase: {
      type: 'string',
      enum: ['phase1', 'phase2', 'phase3', 'phase4'],
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    justification: { type: 'string', minLength: 1 },
  },
};

const prompt = `You are a Wardley Mapping assistant.
Classify the evolution phase of the component "Kubernetes".
Phases: phase1=genesis, phase2=custom-built, phase3=product, phase4=commodity.

Respond ONLY with a single JSON object matching this JSON Schema.
No prose, no markdown, no code fences.

${JSON.stringify(jsonSchema, null, 2)}`;

function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

async function main(): Promise<void> {
  const githubToken = process.env.COPILOT_GITHUB_TOKEN;
  const model = process.env.SPIKE_MODEL ?? 'gpt-5';

  // any: constructor options shape is part of the public preview surface
  const clientOptions: any = githubToken
    ? { githubToken }
    : { useLoggedInUser: true };

  const client = new CopilotClient(clientOptions);
  await client.start();

  try {
    const session = await client.createSession({
      model,
      onPermissionRequest: approveAll,
    });

    let fullText = '';
    const done = new Promise<void>((resolve) => {
      // any: event payload shape is `{ data: { content: string, ... } }` at runtime
      session.on('assistant.message', (event: any) => {
        const chunk: string = event?.data?.content ?? '';
        fullText += chunk;
      });
      session.on('session.idle', () => resolve());
    });

    const t0 = Date.now();
    await session.send({ prompt });
    await done;
    const elapsedMs = Date.now() - t0;

    console.log(`\n--- raw response (${elapsedMs}ms, model=${model}) ---`);
    console.log(fullText);
    console.log('--- end raw ---\n');

    const cleaned = stripFences(fullText);

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      console.error('[FAIL] JSON.parse error:', err);
      process.exitCode = 1;
      await session.disconnect();
      return;
    }

    const validation = SpikeSchema.safeParse(parsed);
    if (!validation.success) {
      console.error('[FAIL] Zod validation failed:', validation.error.issues);
      process.exitCode = 1;
      await session.disconnect();
      return;
    }

    const result: Spike = validation.data;
    console.log('[OK] Parsed and validated:');
    console.log(JSON.stringify(result, null, 2));
    console.log(`\nLatency: ${elapsedMs}ms`);

    await session.disconnect();
  } finally {
    await client.stop();
  }
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
