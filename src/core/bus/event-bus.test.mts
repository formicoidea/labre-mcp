import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEventBus, waitForEvent } from "./event-bus.mjs";
import type { PipelineEvent } from "./event.schema.mjs";

function fakeEvent(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    schemaVersion: "1.0",
    recipeRunId: "test-run",
    stepId: "s1",
    methodId: "wardley:chain:write:capacity:s-curve",
    phase: "step-end",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

describe("createEventBus", () => {
  it("delivers emitted events to observers", async () => {
    const bus = createEventBus();
    const received: PipelineEvent[] = [];
    const subscription = bus.observe().subscribe((e) => received.push(e));
    bus.emit(fakeEvent({ stepId: "a" }));
    bus.emit(fakeEvent({ stepId: "b" }));
    subscription.unsubscribe();
    assert.equal(received.length, 2);
    assert.equal(received[0].stepId, "a");
    assert.equal(received[1].stepId, "b");
  });

  it("filters events via the optional predicate", async () => {
    const bus = createEventBus();
    const received: PipelineEvent[] = [];
    const sub = bus
      .observe((e) => e.phase === "step-end")
      .subscribe((e) => received.push(e));
    bus.emit(fakeEvent({ phase: "step-start" }));
    bus.emit(fakeEvent({ phase: "step-end" }));
    sub.unsubscribe();
    assert.equal(received.length, 1);
    assert.equal(received[0].phase, "step-end");
  });

  it("waitForEvent resolves on the first matching event", async () => {
    const bus = createEventBus();
    const promise = waitForEvent(bus, (e) => e.stepId === "target");
    bus.emit(fakeEvent({ stepId: "other" }));
    bus.emit(fakeEvent({ stepId: "target" }));
    const event = await promise;
    assert.equal(event.stepId, "target");
  });
});
