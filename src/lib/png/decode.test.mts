// Unit tests for the vendored minimal PNG decoder.
//
// PNGs are built by hand here (chunk layout + forward scanline filtering), so
// every case is byte-exact and needs no fixture file. CRCs are zeroed: the
// decoder deliberately does not verify them.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, pixelAt, PngDecodeError } from './decode.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  return out; // trailing 4 CRC bytes stay zero
}

function ihdr(width: number, height: number, opts: { bitDepth?: number; colorType?: number; interlace?: number } = {}): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = opts.bitDepth ?? 8;
  data[9] = opts.colorType ?? 6;
  data[12] = opts.interlace ?? 0;
  return chunk('IHDR', data);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** FORWARD filter one scanline (the encoder side of what decodePng undoes). */
function filterRow(filter: number, row: Buffer, prev: Buffer | null, channels: number): Buffer {
  const out = Buffer.alloc(row.length + 1);
  out[0] = filter;
  for (let i = 0; i < row.length; i++) {
    const left = i >= channels ? row[i - channels] : 0;
    const up = prev !== null ? prev[i] : 0;
    const upLeft = prev !== null && i >= channels ? prev[i - channels] : 0;
    let predictor: number;
    switch (filter) {
      case 0: predictor = 0; break;
      case 1: predictor = left; break;
      case 2: predictor = up; break;
      case 3: predictor = (left + up) >> 1; break;
      case 4: predictor = paeth(left, up, upLeft); break;
      default: throw new Error(`bad filter ${filter}`);
    }
    out[i + 1] = (row[i] - predictor) & 0xff;
  }
  return out;
}

/** Assemble a whole PNG from raw (unfiltered) scanlines + a filter per row. */
function buildPng(width: number, height: number, colorType: 2 | 6, raw: Buffer, filters: number[]): Buffer {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? raw.subarray((y - 1) * stride, y * stride) : null;
    rows.push(filterRow(filters[y], row, prev, channels));
  }
  return Buffer.concat([
    SIGNATURE,
    ihdr(width, height, { colorType }),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('decodePng', () => {
  it('decodes 8-bit RGBA with a plain (None) filter', () => {
    // 2x2: red, green / blue, half-transparent white
    const raw = Buffer.from([
      255, 0, 0, 255,   0, 255, 0, 255,
      0, 0, 255, 255,   255, 255, 255, 128,
    ]);
    const png = decodePng(buildPng(2, 2, 6, raw, [0, 0]));
    assert.equal(png.width, 2);
    assert.equal(png.height, 2);
    assert.deepEqual(pixelAt(png, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(pixelAt(png, 1, 0), [0, 255, 0, 255]);
    assert.deepEqual(pixelAt(png, 0, 1), [0, 0, 255, 255]);
    assert.deepEqual(pixelAt(png, 1, 1), [255, 255, 255, 128]);
  });

  it('decodes 8-bit RGB and expands it to opaque RGBA', () => {
    const raw = Buffer.from([
      10, 20, 30,   40, 50, 60,
      70, 80, 90,   224, 82, 82,
    ]);
    const png = decodePng(buildPng(2, 2, 2, raw, [0, 0]));
    assert.deepEqual(pixelAt(png, 0, 0), [10, 20, 30, 255]);
    assert.deepEqual(pixelAt(png, 1, 1), [224, 82, 82, 255]);
  });

  it('undoes every scanline filter (Sub, Up, Average, Paeth)', () => {
    // 3x5 RGBA of varied bytes, one row per filter type 0..4. Values chosen to
    // wrap around 255 in the filtered domain, exercising the & 0xff paths.
    const stride = 3 * 4;
    const raw = Buffer.alloc(stride * 5);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 37 + 11) & 0xff;
    const png = decodePng(buildPng(3, 5, 6, raw, [0, 1, 2, 3, 4]));
    assert.deepEqual([...png.pixels], [...raw]);
  });

  it('concatenates IDAT data split across several chunks', () => {
    const raw = Buffer.from([200, 100, 50, 255]);
    const compressed = deflateSync(filterRow(0, raw, null, 4));
    const png = decodePng(
      Buffer.concat([
        SIGNATURE,
        ihdr(1, 1),
        chunk('IDAT', compressed.subarray(0, 3)),
        chunk('IDAT', compressed.subarray(3)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
    assert.deepEqual(pixelAt(png, 0, 0), [200, 100, 50, 255]);
  });

  it('ignores ancillary chunks it does not know', () => {
    const raw = Buffer.from([1, 2, 3, 255]);
    const png = decodePng(
      Buffer.concat([
        SIGNATURE,
        ihdr(1, 1),
        chunk('tEXt', Buffer.from('comment')),
        chunk('IDAT', deflateSync(filterRow(0, raw, null, 4))),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
    assert.deepEqual(pixelAt(png, 0, 0), [1, 2, 3, 255]);
  });

  it('rejects everything outside the supported subset with PngDecodeError', () => {
    const cases: Array<[string, Buffer]> = [
      ['bad signature', Buffer.from('definitely not a PNG')],
      ['palette color type', Buffer.concat([SIGNATURE, ihdr(1, 1, { colorType: 3 })])],
      ['grayscale color type', Buffer.concat([SIGNATURE, ihdr(1, 1, { colorType: 0 })])],
      ['16-bit depth', Buffer.concat([SIGNATURE, ihdr(1, 1, { bitDepth: 16 })])],
      ['interlaced', Buffer.concat([SIGNATURE, ihdr(1, 1, { interlace: 1 })])],
      ['no IDAT', Buffer.concat([SIGNATURE, ihdr(1, 1), chunk('IEND', Buffer.alloc(0))])],
      [
        'corrupt IDAT',
        Buffer.concat([SIGNATURE, ihdr(1, 1), chunk('IDAT', Buffer.from([1, 2, 3])), chunk('IEND', Buffer.alloc(0))]),
      ],
      [
        'scanlines shorter than the geometry',
        Buffer.concat([
          SIGNATURE,
          ihdr(4, 4),
          chunk('IDAT', deflateSync(Buffer.from([0, 1, 2, 3, 4]))),
          chunk('IEND', Buffer.alloc(0)),
        ]),
      ],
    ];
    for (const [label, bytes] of cases) {
      assert.throws(() => decodePng(bytes), PngDecodeError, label);
    }
  });
});

describe('pixelAt', () => {
  it('throws RangeError outside the canvas', () => {
    const png = decodePng(buildPng(2, 1, 6, Buffer.from([0, 0, 0, 255, 0, 0, 0, 255]), [0]));
    for (const [x, y] of [[-1, 0], [2, 0], [0, 1], [0.5, 0]] as const) {
      assert.throws(() => pixelAt(png, x, y), RangeError);
    }
  });
});
