import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createEventBus } from '../bus/event-bus.mjs';
import type { PipelineEvent } from '../bus/event.schema.mjs';
import type { PostHogFlags } from '#lib/flags/posthog.mjs';
import { attachPostHogTelemetry } from './posthog-telemetry-listener.mjs';

// A fake PostHogFlags that only records capture() calls — the listener never
// touches the flag-resolution methods, so those are inert stubs.
function buildRecordingFlags(): PostHogFlags & {
  captured: Array<{ event: string; distinctId: string; properties?: Record<string, unknown> }>;
} {
  const captured: Array<{
    event: string;
    distinctId: string;
    properties?: Record<string, unknown>;
  }> = [];
  return {
    captured,
    async isRecipeEnabled() {
      return true;
    },
    async resolvePromptVariants() {
      return {};
    },
    async resolveRecipeVariant() {
      return undefined;
    },
    capture(event, distinctId, properties) {
      captured.push({ event, distinctId, properties });
    },
    async shutdown() {},
  };
}

function runEndEvent(): PipelineEvent {
  return {
    schemaVersion: '1.0',
    recipeRunId: 'run-1',
    stepId: '__run__',
    methodId: 'wardley:recipe:orchestration:run:default',
    phase: 'run-end',
    timestamp: new Date().toISOString(),
  };
}

function stepErrorEvent(): PipelineEvent {
  return {
    schemaVersion: '1.0',
    recipeRunId: 'run-1',
    stepId: 'identify',
    methodId: 'wardley:map:node:identify:default',
    phase: 'step-error',
    timestamp: new Date().toISOString(),
    durationMs: 5,
    payload: { error: 'boom' },
  };
}

// Keys that carry a prompt-experiment attribution property.
function featureKeys(props: Record<string, unknown> | undefined): string[] {
  return Object.keys(props ?? {}).filter((k) => k.startsWith('$feature/'));
}

// Assert no property value looks like prompt text — only short metadata values,
// variant names, and strategy ids are allowed to cross the wire.
function assertNoPromptLikeValues(props: Record<string, unknown> | undefined): void {
  for (const value of Object.values(props ?? {})) {
    if (typeof value !== 'string') continue;
    // Prompt bodies contain interpolation placeholders, newlines, or long prose;
    // variant/strategy ids and method ids never do.
    assert.doesNotMatch(value, /\{\{|\}\}|\n/, `property value looks prompt-like: ${value}`);
    assert.ok(value.length < 120, `property value unexpectedly long: ${value}`);
  }
}

describe('attachPostHogTelemetry — variant attribution', () => {
  it('adds $feature/ properties to BOTH run-end and step-error when variants are present', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({
      bus,
      flags,
      distinctId: 'user-1',
      variants: { 'identify-capability': 'variant-b', 'cpc-mapper': 'variant-a' },
    });

    bus.emit(runEndEvent());
    bus.emit(stepErrorEvent());

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    const stepErr = flags.captured.find((c) => c.event === 'mcp_step_error');
    assert.ok(runEnd, 'run-end must be captured');
    assert.ok(stepErr, 'step-error must be captured');

    // PostHog-native experiment attribution: one $feature/ key per variant, keyed
    // via promptExperimentFlagKey (mcp-prompt-<strategyId>), value = variant name.
    for (const captured of [runEnd, stepErr]) {
      assert.equal(
        captured.properties?.['$feature/mcp-prompt-identify-capability'],
        'variant-b',
      );
      assert.equal(
        captured.properties?.['$feature/mcp-prompt-cpc-mapper'],
        'variant-a',
      );
      assert.equal(featureKeys(captured.properties).length, 2);
      // Metadata keys still present alongside the attribution props.
      assert.equal(captured.properties?.recipeRunId, 'run-1');
      assertNoPromptLikeValues(captured.properties);
    }
  });

  it('adds NO $feature/ properties when no variants are assigned', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    // Omit variants entirely (default path).
    attachPostHogTelemetry({ bus, flags, distinctId: 'daemon' });

    bus.emit(runEndEvent());
    bus.emit(stepErrorEvent());

    for (const captured of flags.captured) {
      assert.equal(featureKeys(captured.properties).length, 0);
      // Exactly the metadata keys — byte-identical to the pre-attribution shape.
      assert.deepEqual(
        Object.keys(captured.properties ?? {}).sort(),
        ['degraded', 'durationMs', 'methodId', 'recipeRunId', 'stepId'],
      );
      assertNoPromptLikeValues(captured.properties);
    }
  });

  it('treats an empty variants map as no attribution', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'daemon', variants: {} });

    bus.emit(runEndEvent());
    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(featureKeys(runEnd?.properties).length, 0);
  });
});

describe('attachPostHogTelemetry — run-end usage + quality (CP9/CP10)', () => {
  it('forwards LLM usage numbers on run-end', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'user-1' });

    bus.emit({
      ...runEndEvent(),
      payload: { usage: { llmCalls: 3, inputTokens: 120, outputTokens: 45 } },
    });

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(runEnd?.properties?.llmCalls, 3);
    assert.equal(runEnd?.properties?.inputTokens, 120);
    assert.equal(runEnd?.properties?.outputTokens, 45);
  });

  it('omits undefined token fields (counts-only provider)', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'user-1' });

    bus.emit({ ...runEndEvent(), payload: { usage: { llmCalls: 2 } } });

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(runEnd?.properties?.llmCalls, 2);
    assert.ok(!('inputTokens' in (runEnd?.properties ?? {})));
    assert.ok(!('outputTokens' in (runEnd?.properties ?? {})));
  });

  it('forwards numeric quality metrics as quality_<name>', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'user-1' });

    bus.emit({
      ...runEndEvent(),
      payload: { quality: { confidence: 0.7, score: 42 } },
    });

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(runEnd?.properties?.quality_confidence, 0.7);
    assert.equal(runEnd?.properties?.quality_score, 42);
  });

  it('sanitizes quality names to [a-zA-Z0-9_]', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'user-1' });

    bus.emit({
      ...runEndEvent(),
      // Runner keys can only be numbers here, but the name may contain unsafe
      // characters — they must all be replaced with '_'.
      payload: { quality: { 'a.b:c-d e': 1 } },
    });

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(runEnd?.properties?.['quality_a_b_c_d_e'], 1);
  });

  it('never forwards non-numeric quality values (privacy)', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'user-1' });

    bus.emit({
      ...runEndEvent(),
      // A defensively malformed payload: a string slipped into quality. It must
      // be dropped, not stringified onto a quality_ property.
      // any: deliberately malformed payload for the privacy guard test.
      payload: { quality: { leak: 'secret prompt text', ok: 5 } as any },
    });

    const runEnd = flags.captured.find((c) => c.event === 'mcp_run_end');
    assert.equal(runEnd?.properties?.quality_ok, 5);
    assert.ok(!('quality_leak' in (runEnd?.properties ?? {})));
    assertNoPromptLikeValues(runEnd?.properties);
  });

  it('does NOT mine payload on step-error (usage/quality are run-end only)', () => {
    const flags = buildRecordingFlags();
    const bus = createEventBus();
    attachPostHogTelemetry({ bus, flags, distinctId: 'user-1' });

    bus.emit({
      ...stepErrorEvent(),
      // any: step-error payload carrying usage should be ignored, not forwarded.
      payload: { usage: { llmCalls: 9 }, error: 'boom' } as any,
    });

    const stepErr = flags.captured.find((c) => c.event === 'mcp_step_error');
    assert.ok(!('llmCalls' in (stepErr?.properties ?? {})));
  });
});
