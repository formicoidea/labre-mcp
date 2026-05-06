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

  it('honours the DSL `size [w, h]` directive in the rendered SVG', () => {
    // cli-owm's parser populates map.presentation.size from `size [...]`.
    // The adapter is responsible for forwarding it to render() — the
    // vendored render() does NOT auto-pull from the parsed map.
    const dsl = [
      'title sized',
      'style plain',
      'size [800, 1000]',
      'anchor A [0.5, 0.5]',
    ].join('\n');
    const svg = new CliOwmAdapter().render(dsl);
    assert.match(svg, /<svg\s[^>]*\bwidth="\d+"/);
    assert.match(svg, /<svg\s[^>]*\bheight="\d+"/);
    // The padding around the visible map area is added by cli-owm
    // (default 35px left, 45px top + corresponding right/bottom). Both
    // declared dimensions appear inflated by this padding.
    const widthMatch  = svg.match(/<svg\s[^>]*\bwidth="(\d+)"/);
    const heightMatch = svg.match(/<svg\s[^>]*\bheight="(\d+)"/);
    assert.ok(widthMatch && heightMatch);
    assert.ok(parseInt(widthMatch[1])  >= 800,  `width  ${widthMatch[1]} should reflect 800`);
    assert.ok(parseInt(heightMatch[1]) >= 1000, `height ${heightMatch[1]} should reflect 1000`);
  });

  it('falls back to cli-owm defaults when the DSL omits `size`', () => {
    // No `size [...]` line — parser leaves presentation.size at {0, 0}.
    // cli-owm internal defaults are 500×600 plus padding.
    const svg = new CliOwmAdapter().render(
      'title default\nstyle plain\nanchor A [0.5, 0.5]',
    );
    assert.match(svg, /<svg\s[^>]*\bwidth="\d+"/);
    const widthMatch = svg.match(/<svg\s[^>]*\bwidth="(\d+)"/);
    assert.ok(widthMatch);
    // 500 + 35 right padding + 35 left = 605 in cli-owm's current
    // emit. Allow a generous range to absorb future cli-owm padding
    // tweaks without flakiness.
    const w = parseInt(widthMatch[1]);
    assert.ok(w >= 500 && w <= 700, `default width ${w} outside expected range`);
  });
});
