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

class DisabledStrategy extends BaseStrategy {
  static get method(): string {
    return "wardley:chain:write:capacity:slow-one";
  }
  static get disabled() {
    return { reason: "high LLM latency (>30 min/run) — pending optimization" };
  }
  async evaluate(): Promise<never> {
    throw new Error("this must never run");
  }
}

class DisabledWithoutReason extends BaseStrategy {
  static get method(): string {
    return "wardley:chain:write:capacity:mystery";
  }
  // any: deliberately the sloppy shape — a bare truthy flag with no reason
  static get disabled(): any {
    return true;
  }
  async evaluate(): Promise<never> {
    throw new Error("this must never run");
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

describe("StrategyRegistry — disabled guard", () => {
  it("refuses to resolve a disabled strategy, and says why", () => {
    const registry = new StrategyRegistry();
    registry.register(DisabledStrategy.method, DisabledStrategy);
    assert.throws(
      () => registry.get(DisabledStrategy.method),
      (err: Error) => {
        assert.match(err.message, /is disabled: /);
        assert.match(err.message, />30 min\/run/);
        assert.match(err.message, /wardley:chain:write:capacity:slow-one/);
        return true;
      },
    );
  });

  it("keeps a disabled strategy in the catalogue — refused is not unregistered", () => {
    const registry = new StrategyRegistry();
    registry.register(DisabledStrategy.method, DisabledStrategy);
    assert.equal(registry.has(DisabledStrategy.method), true);
    assert.deepEqual(registry.list(), [DisabledStrategy.method]);
    assert.equal(registry.size(), 1);
    assert.deepEqual(registry.listDisabled(), [
      {
        methodId: DisabledStrategy.method,
        reason: "high LLM latency (>30 min/run) — pending optimization",
      },
    ]);
  });

  it("still refuses when the flag carries no reason", () => {
    const registry = new StrategyRegistry();
    registry.register(DisabledWithoutReason.method, DisabledWithoutReason);
    assert.throws(
      () => registry.get(DisabledWithoutReason.method),
      /is disabled: no reason given/,
    );
  });

  it("leaves an ordinary strategy alone", () => {
    const registry = new StrategyRegistry();
    registry.register(FakeStrategy.method, FakeStrategy);
    registry.register(DisabledStrategy.method, DisabledStrategy);
    assert.equal(registry.get(FakeStrategy.method), FakeStrategy);
    assert.equal(registry.disabledReason(FakeStrategy.method), undefined);
    assert.equal(
      registry.disabledReason(DisabledStrategy.method),
      "high LLM latency (>30 min/run) — pending optimization",
    );
  });

  it("distinguishes disabled from unknown", () => {
    const registry = new StrategyRegistry();
    registry.register(DisabledStrategy.method, DisabledStrategy);
    assert.throws(
      () => registry.get("wardley:chain:write:capacity:does-not-exist"),
      /Unknown strategy/,
    );
  });
});
