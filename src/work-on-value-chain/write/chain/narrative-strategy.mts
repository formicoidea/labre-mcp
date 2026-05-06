// write:chain:narrative — the first concrete value-chain write strategy.
//
// Composes the six pipeline modules (extract-metadata, generate-chain,
// compute-visibility, minimize-evolution, place-labels, emit-owm) into a
// single-shot flow that turns a natural-language command into an OWM DSL
// document.
//
// The pipeline modules are kept in sibling files (not inlined here) so that
// future `write:chain:*` strategies can recompose them — e.g. a bottom-up
// strategy could reuse compute-visibility + minimize-evolution + place-labels
// + emit-owm while replacing extract-metadata and generate-chain.

import { BaseChainWriteStrategy } from './base-strategy.mjs';
import { extractMetadata } from './extract-metadata.mjs';
import { generateChain } from './generate-chain.mjs';
import { computeVisibility } from './compute-visibility.mjs';
import { spreadXForReadability } from './spread-x.mjs';
import { placeLabels } from './place-labels.mjs';
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

    const metadata           = await extractMetadata(input.nlCommand, this._llmCall);
    const raw                = await generateChain(metadata, this._llmCall);
    const { chain, mapSize } = computeVisibility(raw);
    const withX              = spreadXForReadability(chain);
    const laid               = placeLabels(withX);
    // Caller-provided size always wins so MCP clients can override the
    // density-driven canvas height computed in step 3.
    const emitOptions: EmitOwmOptions = {
      ...(input.emit ?? {}),
      size: input.emit?.size ?? mapSize,
    };
    const owm = generateChainOwmSyntax(laid, emitOptions);
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
