import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StrategyRegistry, validateMethodId } from "./strategy-registry.mjs";
import { BaseStrategy } from "../ast/base-strategy.mjs";

class FakeStrategy extends BaseStrategy {
  static get method(): string {
    return "wardley:chain:write:capacity:s-curve";
  }
  async evaluate(): Promise<never> {
    throw new Error("not implemented");
  }
}

describe("validateMethodId", () => {
  it("accepts a 5-segment id", () => {
    validateMethodId("wardley:chain:write:capacity:s-curve");
  });
  it("rejects 4 segments", () => {
    assert.throws(() => validateMethodId("write:capacity:s-curve:foo"));
  });
  it("rejects 6 segments", () => {
    assert.throws(() => validateMethodId("a:b:c:d:e:f"));
  });
  it("rejects empty segment", () => {
    assert.throws(() => validateMethodId("wardley::write:capacity:x"));
  });
  it("rejects uppercase segments", () => {
    assert.throws(() => validateMethodId("Wardley:chain:write:capacity:x"));
  });
});

describe("StrategyRegistry", () => {
  it("registers and retrieves strategies by methodId", () => {
    const registry = new StrategyRegistry();
    registry.register(FakeStrategy.method, FakeStrategy);
    assert.equal(registry.has(FakeStrategy.method), true);
    assert.equal(registry.get(FakeStrategy.method), FakeStrategy);
    assert.deepEqual(registry.list(), [FakeStrategy.method]);
    assert.equal(registry.size(), 1);
  });

  it("rejects duplicate registration", () => {
    const registry = new StrategyRegistry();
    registry.register(FakeStrategy.method, FakeStrategy);
    assert.throws(() => registry.register(FakeStrategy.method, FakeStrategy));
  });

  it("throws on unknown lookup", () => {
    const registry = new StrategyRegistry();
    assert.throws(() => registry.get("wardley:chain:write:capacity:does-not-exist"));
  });

  it("rejects invalid methodIds at register time", () => {
    const registry = new StrategyRegistry();
    assert.throws(() => registry.register("bad-id", FakeStrategy));
  });
});
