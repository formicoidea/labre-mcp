// Manual smoke test for the generateValueChain MCP handler.
// Routes through opencode (kimi-k2.5) per llm.config.json so it can run from
// inside an active Claude Code session without the Agent SDK subprocess
// conflict (see MEMORY.md -> feedback_agent_sdk_conflict.md).
//
// Usage:
//   npx tsx scripts/smoke-generate-value-chain.mts
//   NL_COMMAND="your custom command" npx tsx scripts/smoke-generate-value-chain.mts
//
// Requires OPENCODE_API_KEY in the environment (.env loaded by node --env-file
// if available, otherwise export manually).

import '../src/lib/prompts/init.mjs';
import { handleGenerateValueChain } from '../src/work-on-value-chain/write/chain/generate-value-chain.mjs';
import { runWithCollector } from '../src/lib/degradation/index.mjs';
import { DegradationCollector } from '../src/lib/degradation/index.mjs';

const DEFAULT_COMMAND =
  "construis-moi la chaîne de valeur d'un fournisseur de solution de paiement en ligne";

async function main(): Promise<void> {
  if (!process.env.OPENCODE_API_KEY) {
    console.error('OPENCODE_API_KEY not set — run with a shell that exports it, or pass --env-file=.env');
    process.exit(1);
  }

  const nlCommand = process.env.NL_COMMAND ?? DEFAULT_COMMAND;
  console.log(`\n► Command: ${nlCommand}\n`);

  const collector = new DegradationCollector('smoke:generateValueChain');
  const started = Date.now();

  try {
    const result = await runWithCollector(collector, () => handleGenerateValueChain({ nlCommand }));
    const elapsed = Date.now() - started;

    console.log(`✓ Completed in ${elapsed}ms`);
    console.log(`\n── Metadata ──────────────────────────────────────────`);
    console.log(JSON.stringify(result.metadata, null, 2));
    console.log(`\n── OWM DSL ───────────────────────────────────────────`);
    console.log(result.owm);

    if (collector.hasDegraded()) {
      console.log(`\n── Degradation events ────────────────────────────────`);
      for (const evt of collector.getEvents()) {
        console.log(`  [${evt.severity}] ${evt.source}: ${evt.reason}`);
      }
    }

    console.log(`\n→ Paste the OWM block at https://onlinewardleymaps.com to render.`);
  } catch (err) {
    const elapsed = Date.now() - started;
    console.error(`✗ Failed after ${elapsed}ms: ${(err as Error).message}`);
    if (collector.hasDegraded()) {
      console.error(`\nDegradation events:`);
      for (const evt of collector.getEvents()) {
        console.error(`  [${evt.severity}] ${evt.source}: ${evt.reason}`);
      }
    }
    process.exit(1);
  }
}

void main();
