// Tests for candidate-offsets.mts — per-label candidate generation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidatesFor,
  LEFT_FLUSH_BUFFER_PX,
  RIGHT_OFFSET_PX,
  TOP_OFFSET_PX,
  BOTTOM_OFFSET_PX,
  DIAGONAL_DY_OFFSET_PX,
} from './candidate-offsets.mjs';
import { LABEL_CHAR_WIDTH } from './svg-bbox-parser.mjs';

describe('candidatesFor', () => {
  it('returns exactly 8 candidates per call', () => {
    assert.equal(candidatesFor('Foo').length, 8);
    assert.equal(candidatesFor('a').length, 8);
    assert.equal(candidatesFor('A long-ish component name').length, 8);
  });

  it('scales the LEFT dx proportionally with label length', () => {
    const short = candidatesFor('Foo');                    // 3 chars
    const longer = candidatesFor('Foo Bar Baz');           // 11 chars
    const dxShort = short.find(c => c.dx < 0 && c.dy === 0)!.dx;
    const dxLong  = longer.find(c => c.dx < 0 && c.dy === 0)!.dx;
    // Longer name -> more negative dx (further left).
    assert.ok(dxLong < dxShort, `expected ${dxLong} < ${dxShort}`);
    // Sanity: dxShort = -(3 × 7 + 3) = -24
    assert.equal(dxShort, -(3 * LABEL_CHAR_WIDTH + LEFT_FLUSH_BUFFER_PX));
    // Sanity: dxLong = -(11 × 7 + 3) = -80
    assert.equal(dxLong, -(11 * LABEL_CHAR_WIDTH + LEFT_FLUSH_BUFFER_PX));
  });

  it('keeps RIGHT dx constant regardless of label length', () => {
    const short = candidatesFor('Foo').find(c => c.dx > 0 && c.dy === 0)!.dx;
    const long  = candidatesFor('Foo Bar Baz Qux Quux').find(c => c.dx > 0 && c.dy === 0)!.dx;
    assert.equal(short, RIGHT_OFFSET_PX);
    assert.equal(long, RIGHT_OFFSET_PX);
  });

  it('exposes both cardinals and diagonals', () => {
    const cs = candidatesFor('A');
    const cardinals = cs.filter(c => c.dx === 0 || c.dy === 0);
    const diagonals = cs.filter(c => c.dx !== 0 && c.dy !== 0);
    assert.equal(cardinals.length, 4);
    assert.equal(diagonals.length, 4);
    assert.ok(cs.some(c => c.dx === 0 && c.dy === BOTTOM_OFFSET_PX));
    assert.ok(cs.some(c => c.dx === 0 && c.dy === TOP_OFFSET_PX));
  });

  it('uses the same dy magnitude for diagonals (DIAGONAL_DY_OFFSET_PX)', () => {
    const cs = candidatesFor('A');
    const diagonals = cs.filter(c => c.dx !== 0 && c.dy !== 0);
    for (const d of diagonals) {
      assert.equal(Math.abs(d.dy), DIAGONAL_DY_OFFSET_PX);
    }
  });

  it('falls back to a single-char width on empty names (defensive)', () => {
    const cs = candidatesFor('');
    const dxLeft = cs.find(c => c.dx < 0 && c.dy === 0)!.dx;
    assert.equal(dxLeft, -(LABEL_CHAR_WIDTH + LEFT_FLUSH_BUFFER_PX));
  });
});
