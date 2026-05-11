import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  WardleyEvolutionASTSchema,
  EVOLUTION_AST_SCHEMA_VERSION,
  type WardleyEvolutionAST,
} from "./wardley-evolution-ast.mjs";

function validAst(): WardleyEvolutionAST {
  return {
    schemaVersion: "1.0",
    subject: {
      name: "Kubernetes",
      capability: "container orchestration",
      description: "Open-source container orchestration platform",
      context: "cloud infrastructure",
      date: "2025",
    },
    generatedAt: "2026-05-10T14:23:00Z",
    signals: [
      {
        name: "certitude",
        value: 0.9,
        source: "user-input",
        capturedAt: "2026-05-10T14:23:00Z",
      },
    ],
    reasoning: [
      {
        by: "wardley:evolution:write:capacity:llm-direct",
        text: "Kubernetes is a mature, broadly adopted container orchestration platform. Multiple vendors provide managed services...",
        promptTokens: 320,
        completionTokens: 180,
      },
    ],
    insights: [
      {
        text: "Container orchestration has reached commodity status; competition is on managed-service ergonomics.",
        by: "wardley:evolution:write:capacity:llm-direct",
        type: "trajectory",
        confidence: 0.85,
      },
    ],
    result: {
      evolution: 0.78,
      confidence: 0.85,
      method: "wardley:evolution:write:capacity:llm-direct",
    },
  };
}

describe("WardleyEvolutionASTSchema (γ form, ARCH-22)", () => {
  it("accepts a fully-populated AST", () => {
    const parsed = WardleyEvolutionASTSchema.safeParse(validAst());
    assert.equal(parsed.success, true);
  });

  it("accepts an AST with empty signals/reasoning/insights arrays", () => {
    const ast = validAst();
    ast.signals = [];
    ast.reasoning = [];
    ast.insights = [];
    const parsed = WardleyEvolutionASTSchema.safeParse(ast);
    assert.equal(parsed.success, true);
  });

  it("rejects an AST with evolution > 1", () => {
    const ast = validAst();
    ast.result.evolution = 1.2;
    const parsed = WardleyEvolutionASTSchema.safeParse(ast);
    assert.equal(parsed.success, false);
  });

  it("rejects an AST without result", () => {
    const ast = validAst() as Partial<WardleyEvolutionAST>;
    // any: deliberately delete a required field for the negative test
    delete (ast as { result?: unknown }).result;
    const parsed = WardleyEvolutionASTSchema.safeParse(ast);
    assert.equal(parsed.success, false);
  });

  it("accepts consensus across multiple contributing strategies", () => {
    const ast = validAst();
    ast.result.consensus = {
      contributingStrategies: [
        "wardley:evolution:write:capacity:s-curve",
        "wardley:evolution:write:capacity:llm-direct",
      ],
      agreement: 0.92,
      divergence: [
        { strategy: "wardley:evolution:write:capacity:s-curve", value: 0.81 },
        { strategy: "wardley:evolution:write:capacity:llm-direct", value: 0.78 },
      ],
    };
    const parsed = WardleyEvolutionASTSchema.safeParse(ast);
    assert.equal(parsed.success, true);
  });

  it("exports the canonical schema version constant", () => {
    assert.equal(EVOLUTION_AST_SCHEMA_VERSION, "1.0");
  });
});
