// write:chain:top-down — the first concrete value-chain write strategy.
// Implements the top-down Wardley algorithm: anchor → needs → capabilities → links.
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

import { BaseChainWriteStrategy } from '../base-strategy.mjs';
import { extractMetadata } from '../../lib/llm/extract-metadata.mjs';
import { generateChain } from './generate-chain.mjs';
import { computeVisibility } from '../../lib/layout/compute-visibility.mjs';
import { adjustX } from '../../lib/layout/adjust-x.mjs';
import { placeLabels } from '../../lib/layout/place-labels.mjs';
import { verifyLayout } from '../../lib/layout/verify-layout.mjs';
import { generateChainOwmSyntax, type EmitOwmOptions } from '../../lib/emit/emit-owm.mjs';
import type { ChainMetadata } from '#types/value-chain.mjs';

// any: llmCall closure shape is provider-dependent (see src/lib/llm)
type LlmCall = any;

export interface TopDownChainInput {
  nlCommand: string;
  /** Optional OWM rendering options forwarded to emit-owm. */
  emit?: EmitOwmOptions;
}

export interface TopDownChainFullResult {
  owm: string;
  metadata: ChainMetadata;
}

export class TopDownChainStrategy extends BaseChainWriteStrategy {
  static get method(): string {
    return 'write:chain:top-down';
  }

  private readonly _llmCall: LlmCall;

  // any: destructured options bag mirrors the convention of other strategies
  constructor({ llmCall }: any = {}) {
    super();
    if (typeof llmCall !== 'function') {
      throw new Error('TopDownChainStrategy requires an llmCall function');
    }
    this._llmCall = llmCall;
  }

  /**
   * Full pipeline output — OWM DSL plus the metadata extracted by LLM #1.
   * Consumers that need to persist the context alongside the map (e.g. the
   * MCP tool handler) should call this rather than `build`.
   */
  async buildFull(input: TopDownChainInput): Promise<TopDownChainFullResult> {
    if (!input?.nlCommand || typeof input.nlCommand !== 'string') {
      throw new Error('TopDownChainStrategy.build requires a non-empty nlCommand');
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
  async build(input: TopDownChainInput): Promise<string> {
    const { owm } = await this.buildFull(input);
    return owm;
  }
}

// ─── Core BaseStrategy adapter ──────────────────────────────────────────────
//
// Wraps the legacy `TopDownChainStrategy` in the core BaseStrategy contract.
// Note the divergent return shape: chain generation produces
// `{ owm: string, metadata: ChainMetadata }`, NOT an EvolutionResult.

import {
  BaseStrategy as CoreBaseStrategy,
  type StrategyResult,
} from '#core/ast/base-strategy.mjs';
import type { RequestContext } from '#core/context/request-context.mjs';
import type { LLMCall } from '#types/llm.mjs';
import { getStrategyLLM } from '#lib/llm/registry.mjs';

const NEW_METHOD_ID_TOPDOWN = 'wardley:map:value-chain:generate:top-down';

export class TopDownChainStrategyCore
  extends CoreBaseStrategy<TopDownChainInput, TopDownChainFullResult>
{
  private readonly _llmCall: LLMCall | null;

  constructor(options: { llmCall?: LLMCall } = {}) {
    super();
    this._llmCall = options.llmCall ?? null;
  }

  static get method(): string {
    return NEW_METHOD_ID_TOPDOWN;
  }

  async evaluate(
    input: TopDownChainInput,
    _context: RequestContext,
  ): Promise<StrategyResult<TopDownChainFullResult>> {
    const llmCall: LLMCall = this._llmCall ?? getStrategyLLM('write-chain');
    const legacy = new TopDownChainStrategy({ llmCall });
    const result = await legacy.buildFull(input);

    const capturedAt = new Date().toISOString();
    // any: metadata is the LLM #1 extracted structure (title, anchor, lang, etc.);
    // ChainMetadata has a fixed shape but we look up arbitrary keys defensively.
    const metadata = (result.metadata ?? {}) as unknown as Record<string, unknown>;
    const signals = [
      { name: 'nlCommand', value: input.nlCommand, source: 'user-input' as const, capturedAt },
      ...(typeof metadata.lang === 'string'
        ? [{ name: 'language', value: metadata.lang, source: 'llm-internal' as const, capturedAt }]
        : []),
      ...(typeof metadata.title === 'string'
        ? [{ name: 'title', value: metadata.title, source: 'llm-internal' as const, capturedAt }]
        : []),
    ];
    // Surface the extracted anchor as an insight — it is the LLM's structural
    // interpretation of the natural-language command and drives the rest of
    // the chain build.
    const insights = typeof metadata.anchor === 'string'
      ? [{
          text: `Anchor extracted from natural-language command: "${metadata.anchor}"`,
          by: NEW_METHOD_ID_TOPDOWN,
          type: 'other' as const,
        }]
      : [];
    return {
      signals,
      reasoning: [],
      insights,
      result,
    };
  }
}
