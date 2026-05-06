// write:chain:narrative — the first concrete value-chain write strategy.
//
// Composes the eight pipeline modules (extract-metadata, generate-chain,
// propose-x-rough, compute-visibility, adjust-x, place-labels,
// verify-layout, emit-owm) into a single-shot flow that turns a
// natural-language command into an OWM DSL document.
//
// propose-x-rough (LLM #3) and compute-visibility are independent (X vs Y)
// and run in parallel via Promise.all to halve the latency of this stage.
//
// verify-layout closes the loop on label placement: it renders the chain
// via the OwmRenderAdapter (cli-owm by default), parses the SVG into
// bboxes, detects overlaps, and reassigns label offsets until the
// rendering is clean or the iteration cap is reached.
//
// The pipeline modules are kept in sibling files (not inlined here) so
// that future `write:chain:*` strategies can recompose them — e.g. a
// bottom-up strategy could reuse compute-visibility + adjust-x + place-
// labels + verify-layout + emit-owm while replacing extract-metadata
// and generate-chain.

import { BaseChainWriteStrategy } from './base-strategy.mjs';
import { extractMetadata } from './extract-metadata.mjs';
import { generateChain } from './generate-chain.mjs';
import { proposeXRough } from './propose-x-rough.mjs';
import { computeVisibility } from './compute-visibility.mjs';
import { adjustX } from './adjust-x.mjs';
import { placeLabels } from './place-labels.mjs';
import { verifyLayout } from './verify-layout.mjs';
import { generateChainOwmSyntax, type EmitOwmOptions } from './emit-owm.mjs';
import { getRenderAdapter } from '../../../lib/owm/render-registry.mjs';
import type {
  ChainMetadata,
  PositionedComponent,
  PositionedValueChain,
} from '../../../types/value-chain.mjs';

// any: llmCall closure shape is provider-dependent (see src/lib/llm)
type LlmCall = any;

export interface NarrativeChainInput {
  nlCommand: string;
  /** Optional OWM rendering options forwarded to emit-owm. */
  emit?: EmitOwmOptions;
}

export interface NarrativeChainFullResult {
  owm: string;
  metadata: ChainMetadata;
}

export class NarrativeChainStrategy extends BaseChainWriteStrategy {
  static get method(): string {
    return 'write:chain:narrative';
  }

  private readonly _llmCall: LlmCall;

  // any: destructured options bag mirrors the convention of other strategies
  constructor({ llmCall }: any = {}) {
    super();
    if (typeof llmCall !== 'function') {
      throw new Error('NarrativeChainStrategy requires an llmCall function');
    }
    this._llmCall = llmCall;
  }

  /**
   * Full pipeline output — OWM DSL plus the metadata extracted by LLM #1.
   * Consumers that need to persist the context alongside the map (e.g. the
   * MCP tool handler) should call this rather than `build`.
   */
  async buildFull(input: NarrativeChainInput): Promise<NarrativeChainFullResult> {
    if (!input?.nlCommand || typeof input.nlCommand !== 'string') {
      throw new Error('NarrativeChainStrategy.build requires a non-empty nlCommand');
    }

    const metadata = await extractMetadata(input.nlCommand, this._llmCall);
    const raw      = await generateChain(metadata, this._llmCall);

    // Steps 3 (LLM #3 X hint) and 4 (deterministic Y) are independent —
    // run them in parallel.
    const [rawWithHints, visibility] = await Promise.all([
      proposeXRough(raw, this._llmCall),
      Promise.resolve(computeVisibility(raw)),
    ]);

    // Merge xHints onto the positioned chain so adjust-x can read them.
    const hintByName = new Map(
      rawWithHints.components.map(c => [c.name, c.xHint] as const),
    );
    const hintedChain: PositionedValueChain = {
      metadata: visibility.chain.metadata,
      links: visibility.chain.links,
      components: visibility.chain.components.map<PositionedComponent>(c => ({
        ...c,
        xHint: hintByName.get(c.name) ?? c.xHint,
      })),
    };

    const adjusted = adjustX(hintedChain);
    const laid     = placeLabels(adjusted.chain);

    // Caller-provided size always wins so MCP clients can override the
    // density-driven canvas dimensions computed in steps 3 and 5.
    const computedSize = {
      width: adjusted.mapSize.width,
      height: visibility.mapSize.height,
    };
    const emitOptions: EmitOwmOptions = {
      ...(input.emit ?? {}),
      size: input.emit?.size ?? computedSize,
    };

    // Step 7: collision-aware label correction. The render adapter is
    // resolved once here and passed in so unit tests can inject a mock.
    const verified = verifyLayout(laid, emitOptions, getRenderAdapter());
    const owm      = generateChainOwmSyntax(verified.chain, emitOptions);
    return { owm, metadata };
  }

  /**
   * Backwards-compatible narrow output required by `BaseChainWriteStrategy`.
   * Delegates to `buildFull` and discards the metadata.
   */
  async build(input: NarrativeChainInput): Promise<string> {
    const { owm } = await this.buildFull(input);
    return owm;
  }
}
