// Smoke test for CliOwmAdapter — confirms the adapter boundary
// produces a non-empty SVG for a trivial DSL. The deeper rendering
// behaviour is already covered by the vendored smoke test
// (src/lib/vendor/cli-owm/__smoke.test.mts).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CliOwmAdapter } from './cli-owm-adapter.mjs';

describe('CliOwmAdapter', () => {
  it('renders a trivial DSL into a non-empty SVG string', () => {
    const adapter = new CliOwmAdapter();
    const svg = adapter.render(
      'title test\nstyle plain\nanchor A [0.5, 0.5]',
    );
    assert.equal(typeof svg, 'string');
    assert.ok(svg.length >= 100, `SVG too short: ${svg.length} chars`);
    assert.match(svg, /<svg\b/);
    assert.match(svg, /<\/svg>/);
  });

  it('renders a multi-component DSL preserving every name as substring', () => {
    const dsl = [
      'title chain',
      'style plain',
      'anchor User [0.95, 0.5]',
      'component Need A [0.7, 0.3]',
      'component Capability X [0.4, 0.6]',
      'User->Need A',
      'Need A->Capability X',
    ].join('\n');
    const svg = new CliOwmAdapter().render(dsl);
    assert.match(svg, /User/);
    assert.match(svg, /Need A/);
    assert.match(svg, /Capability X/);
  });
});
