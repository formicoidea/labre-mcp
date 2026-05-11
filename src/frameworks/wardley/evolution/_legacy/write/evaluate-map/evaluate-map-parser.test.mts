// Unit tests for evaluate-map pure functions: parser, WM content updater, report formatter.
// The end-to-end evaluateMapFile is intentionally not exercised here (it calls the full
// estimateEvolution pipeline); progress-notification coverage lives in evaluate-map-notifications.test.mts.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseWardleyMap, updateWmContent, formatEvaluationReport } from './evaluate-map.mjs';

const SAMPLE_WM = `title Tea Shop

anchor Business [0.95, 0.63]

component Cup of Tea [0.79, 0.61]
component Cup [0.73, 0.78] (buy)
component Tea [0.63, 0.45]
component Hot Water [0.52, 0.82]
component Kettle [0.32, 0.33] (inertia) label [-48, -13]
component Power [0.11, 0.89]

Business->Cup of Tea
Cup of Tea->Cup
Cup of Tea->Tea
Cup of Tea->Hot Water
Hot Water->Kettle
Kettle->Power

style wardley`;

describe('parseWardleyMap', () => {
  const parsed = parseWardleyMap(SAMPLE_WM);

  it('extracts the title', () => {
    assert.equal(parsed.title, 'Tea Shop');
  });

  it('extracts the style', () => {
    assert.equal(parsed.style, 'wardley');
  });

  it('extracts anchors with visibility and maturity', () => {
    assert.equal(parsed.anchors.length, 1);
    assert.equal(parsed.anchors[0].name, 'Business');
    assert.equal(parsed.anchors[0].visibility, 0.95);
    assert.equal(parsed.anchors[0].maturity, 0.63);
  });

  it('extracts 6 components', () => {
    assert.equal(parsed.components.length, 6);
  });

  it('preserves multi-word component names', () => {
    assert.ok(parsed.components.some((c: any) => c.name === 'Cup of Tea'));
    assert.ok(parsed.components.some((c: any) => c.name === 'Hot Water'));
  });

  it('captures decorators', () => {
    const cup = parsed.components.find((c: any) => c.name === 'Cup');
    assert.deepEqual(cup?.decorators, ['buy']);
  });

  it('captures label offsets', () => {
    const kettle = parsed.components.find((c: any) => c.name === 'Kettle');
    assert.deepEqual(kettle?.label, [-48, -13]);
  });

  it('extracts links', () => {
    assert.ok(parsed.links.length >= 6);
    assert.ok(parsed.links.some((l: any) => l.from === 'Business' && l.to === 'Cup of Tea'));
  });

  it('returns empty arrays for missing sections', () => {
    const empty = parseWardleyMap('');
    assert.equal(empty.components.length, 0);
    assert.equal(empty.anchors.length, 0);
    assert.equal(empty.title, null);
  });
});

describe('updateWmContent', () => {
  it('updates a component maturity value in place', () => {
    const updated = updateWmContent(SAMPLE_WM, [{
      name: 'Tea',
      type: 'component',
      originalMaturity: 0.45,
      newMaturity: 0.72,
      classification: 'economic',
      strategies: null,
      skipped: false,
    } as any]);
    assert.ok(updated.includes('component Tea [0.63, 0.72]'));
    assert.ok(!updated.includes('component Tea [0.63, 0.45]'));
  });

  it('updates anchor maturity', () => {
    const updated = updateWmContent(SAMPLE_WM, [{
      name: 'Business',
      type: 'anchor',
      originalMaturity: 0.63,
      newMaturity: 0.80,
      classification: 'economic',
      strategies: null,
      skipped: false,
    } as any]);
    assert.ok(updated.includes('anchor Business [0.95, 0.80]'));
  });

  it('skips evaluations marked as skipped or with null newMaturity', () => {
    const updated = updateWmContent(SAMPLE_WM, [
      { name: 'Power', type: 'component', originalMaturity: 0.89, newMaturity: null, skipped: true } as any,
    ]);
    assert.equal(updated, SAMPLE_WM);
  });

  it('preserves decorators and labels when updating', () => {
    const updated = updateWmContent(SAMPLE_WM, [{
      name: 'Kettle',
      type: 'component',
      originalMaturity: 0.33,
      newMaturity: 0.50,
      classification: 'economic',
      strategies: null,
      skipped: false,
    } as any]);
    assert.ok(updated.includes('component Kettle [0.32, 0.50] (inertia) label [-48, -13]'));
  });
});

describe('formatEvaluationReport', () => {
  it('renders a markdown table with summary footer', () => {
    const evals = [
      { name: 'Tea', originalMaturity: 0.45, newMaturity: 0.55, delta: 0.10, skipped: false, classification: 'economic' } as any,
      { name: 'Air', originalMaturity: 0.50, newMaturity: null, skipped: true, classification: 'social_good' } as any,
    ];
    const summary = { total: 2, evaluated: 1, skipped: 1, avgDelta: 0.10 };
    const report = formatEvaluationReport(evals, summary);
    assert.ok(report.includes('| Component |'));
    assert.ok(report.includes('Tea'));
    assert.ok(report.includes('Air'));
    assert.ok(report.includes('skipped'));
    assert.ok(report.includes('1/2 evaluated'));
  });
});
