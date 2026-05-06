// write:chain:narrative — the first concrete value-chain write strategy.
//
// Composes the seven pipeline modules (extract-metadata, generate-chain,
// compute-visibility, adjust-x, place-labels, verify-layout, emit-owm)
// into a single-shot flow that turns a natural-language command into an
// OWM DSL document.
//
// Two LLM calls only:
//   1. extract-metadata — angle/scope/objective/imperatives/temporality.
//   2. generate-chain   — chain shape (anchors, components, links, phases)
//                         plus an inline `xHint` per component for visual
//                         clarity.
// All later stages (compute-visibility, adjust-x, place-labels,
// verify-layout, emit-owm) are pure deterministic JS.
//
// verify-layout closes the loop on label placement: it computes the chain
// geometry analytically, detects overlaps, and reassigns label offsets via
// force-directed simulation + canonical snap until the rendering is clean
// or the iteration cap is reached.
//
// The pipeline modules are kept in sibling files (not inlined here) so
// that future `write:chain:*` strategies can recompose them — e.g. a
// bottom-up strategy could reuse compute-visibility + adjust-x + place-
// labels + verify-layout + emit-owm while replacing extract-metadata
// and generate-chain.

import { BaseChainWriteStrategy } from './base-strategy.mjs';
import { extractMetadata } from './extract-metadata.mjs';
import { generateChain } from './generate-chain.mjs';
import { computeVisibility } from './compute-visibility.mjs';
import { adjustX } from './adjust-x.mjs';
import { placeLabels } from './place-labels.mjs';
import { verifyLayout } from './verify-layout.mjs';
import { generateChainOwmSyntax, type EmitOwmOptions } from './emit-owm.mjs';
import type { ChainMetadata } from '../../../types/value-chain.mjs';

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
    // LLM #2 returns the chain plus each component's xHint inline.
    const raw      = await generateChain(metadata, this._llmCall);

    // Deterministic Y assignment from the parsed chain. xHints are already
    // on raw.components, so adjust-x reads them directly via the
    // PositionedValueChain produced by computeVisibility.
    const visibility = computeVisibility(raw);

    const adjusted = adjustX(visibility.chain);
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

    // Step 6: collision-aware label correction.
    const verified = verifyLayout(laid, emitOptions);
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
