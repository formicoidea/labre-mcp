// Smoke test: validates that Node.js subpath imports (#core/*, #lib/*, etc.)
// declared in package.json resolve correctly under tsc typecheck AND tsx
// runtime. This is the foundation that lets us move files between
// directories without breaking imports.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { StrategyRegistry } from "#core/registry/strategy-registry.mjs";
import { createEventBus } from "#core/bus/event-bus.mjs";

describe("Node.js subpath imports", () => {
  it("resolves #core/registry/strategy-registry.mjs", () => {
    const registry = new StrategyRegistry();
    assert.equal(registry.size(), 0);
  });

  it("resolves #core/bus/event-bus.mjs", () => {
    const bus = createEventBus();
    assert.equal(typeof bus.emit, "function");
    assert.equal(typeof bus.observe, "function");
  });
});
