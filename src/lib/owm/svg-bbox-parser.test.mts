// Tests for svg-bbox-parser.mts
//
// Two layers:
//   (1) Synthetic SVG fixtures — exercise edge cases of the regex
//       walker without depending on the cli-owm vendoring.
//   (2) Round-trip via the real CliOwmAdapter on a tiny DSL — proves
//       the parser still works against the actual vendored renderer
//       output. This is the contract test that fails immediately if
//       cli-owm's SVG shape changes.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSvgToBboxes,
  LABEL_CHAR_WIDTH,
  LABEL_HEIGHT,
  COMPONENT_RADIUS,
} from './svg-bbox-parser.mjs';
import { CliOwmAdapter } from './cli-owm-adapter.mjs';

describe('parseSvgToBboxes — synthetic fixtures', () => {
  it('emits an anchor for a middle-anchored text matching a known name', () => {
    const svg = `<svg>
      <text x="250" y="30" text-anchor="middle" font-size="14px">User</text>
    </svg>`;
    const out = parseSvgToBboxes(svg, new Set(['User']));
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, 'anchor');
    assert.equal(out[0].name, 'User');
    // Middle-anchored: x is the centre, so bbox.x = 250 - width/2.
    const expectedWidth = 4 * LABEL_CHAR_WIDTH; // "User" = 4 chars
    assert.equal(out[0].bbox.width, expectedWidth);
    assert.equal(out[0].bbox.x, 250 - expectedWidth / 2);
    assert.equal(out[0].bbox.height, LABEL_HEIGHT);
  });

  it('pairs a circle with the next matching text as a component + label', () => {
    const svg = `<svg>
      <circle cx="150" cy="180" r="5"/>
      <text x="155" y="170" font-size="14px">Need A</text>
    </svg>`;
    const out = parseSvgToBboxes(svg, new Set(['Need A']));
    assert.equal(out.length, 2);
    const comp = out.find(g => g.kind === 'component');
    const lbl = out.find(g => g.kind === 'label');
    assert.ok(comp && lbl);
    assert.deepEqual(comp.bbox, {
      x: 150 - COMPONENT_RADIUS,
      y: 180 - COMPONENT_RADIUS,
      width: 2 * COMPONENT_RADIUS,
      height: 2 * COMPONENT_RADIUS,
    });
    // Text-anchor defaults to "start": bbox.x = x.
    assert.equal(lbl.bbox.x, 155);
  });

  it('drops circles whose next text is not in knownNames', () => {
    const svg = `<svg>
      <circle cx="150" cy="180" r="5"/>
      <text x="155" y="170">Decoration</text>
    </svg>`;
    const out = parseSvgToBboxes(svg, new Set(['Need A']));
    assert.equal(out.length, 0);
  });

  it('skips content inside <defs> and decoration groups', () => {
    const svg = `<svg>
      <defs>
        <pattern id="diagonalHatch"><path d="..."/></pattern>
      </defs>
      <g id="valueChain"><text x="0" y="0">Value Chain</text></g>
      <g id="Evolution"><text x="0" y="0">Genesis</text></g>
      <text x="100" y="100" text-anchor="middle">Anchor</text>
    </svg>`;
    const out = parseSvgToBboxes(svg, new Set(['Anchor', 'Value Chain', 'Genesis']));
    // Even if "Value Chain" / "Genesis" happened to match, they live
    // inside stripped groups and must not appear.
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'Anchor');
  });

  it('decodes XML entities in component names', () => {
    const svg = `<svg>
      <circle cx="10" cy="20" r="5"/>
      <text x="15" y="20">A &amp; B</text>
    </svg>`;
    const out = parseSvgToBboxes(svg, new Set(['A & B']));
    assert.equal(out.length, 2);
    assert.ok(out.every(g => g.name === 'A & B'));
  });

  it('handles multiple component+label pairs in document order', () => {
    const svg = `<svg>
      <circle cx="100" cy="100" r="5"/>
      <text x="105" y="100">Alpha</text>
      <circle cx="200" cy="200" r="5"/>
      <text x="205" y="200">Beta</text>
    </svg>`;
    const out = parseSvgToBboxes(svg, new Set(['Alpha', 'Beta']));
    const comps = out.filter(g => g.kind === 'component');
    const labels = out.filter(g => g.kind === 'label');
    assert.equal(comps.length, 2);
    assert.equal(labels.length, 2);
    assert.ok(comps.find(g => g.name === 'Alpha'));
    assert.ok(comps.find(g => g.name === 'Beta'));
  });

  it('returns an empty report when knownNames is empty', () => {
    const svg = `<svg><circle cx="10" cy="10" r="5"/><text x="15" y="10">X</text></svg>`;
    assert.deepEqual(parseSvgToBboxes(svg, new Set()), []);
  });
});

describe('parseSvgToBboxes — round-trip via CliOwmAdapter', () => {
  it('extracts every component and the anchor from a real cli-owm render', () => {
    const dsl = [
      'title round-trip',
      'style plain',
      'anchor User [0.95, 0.5]',
      'component Need A [0.7, 0.3]',
      'component Capability X [0.4, 0.6]',
      'User->Need A',
      'Need A->Capability X',
    ].join('\n');
    const svg = new CliOwmAdapter().render(dsl);
    const out = parseSvgToBboxes(
      svg,
      new Set(['User', 'Need A', 'Capability X']),
    );

    // Anchor: 1 entry. Each of the 2 components: 2 entries (component + label).
    const anchors = out.filter(g => g.kind === 'anchor');
    const comps   = out.filter(g => g.kind === 'component');
    const labels  = out.filter(g => g.kind === 'label');
    assert.equal(anchors.length, 1, 'expected 1 anchor');
    assert.equal(comps.length, 2, 'expected 2 components');
    assert.equal(labels.length, 2, 'expected 2 labels');

    assert.equal(anchors[0].name, 'User');
    assert.ok(comps.find(g => g.name === 'Need A'));
    assert.ok(comps.find(g => g.name === 'Capability X'));

    // Sanity: every bbox has positive width and height.
    for (const g of out) {
      assert.ok(g.bbox.width > 0,  `${g.name} ${g.kind} width <= 0`);
      assert.ok(g.bbox.height > 0, `${g.name} ${g.kind} height <= 0`);
    }
  });
});
