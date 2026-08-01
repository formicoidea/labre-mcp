// Minimal PNG decoder — vendored, zero npm dependencies (same precedent as
// `#lib/owm/svg-bbox-parser`: low-level parsing kept in-house on purpose).
//
// Scope is deliberately the subset OUR renderer (resvg) emits: 8-bit truecolor
// (RGB or RGBA), non-interlaced, zlib-compressed. Anything else — palette,
// grayscale, 16-bit, Adam7 — throws a clean `PngDecodeError`; callers treat
// that as "pixel sampling unavailable" and fall back, never as a crash.

import { inflateSync } from 'node:zlib';

export class PngDecodeError extends Error {}

export interface DecodedPng {
  width: number;
  height: number;
  /** Always RGBA, 4 bytes per pixel, row-major (RGB input is expanded). */
  pixels: Buffer;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Paeth predictor (PNG spec § 9, filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngDecodeError('not a PNG: bad signature');
  }

  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length < length) throw new PngDecodeError(`truncated ${type} chunk`);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      const interlace = data[12];
      // data[10] (compression) and data[11] (filter) have a single legal value
      // (0) in the spec; zlib and the per-scanline defiltering below assume it.
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new PngDecodeError(
          `unsupported format (bitDepth=${bitDepth}, colorType=${colorType}): ` +
            'only 8-bit truecolor RGB/RGBA is decoded',
        );
      }
      if (interlace !== 0) throw new PngDecodeError('interlaced PNG is not decoded');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    // 12 = length field + type field + trailing CRC (CRC not verified: the
    // bytes come straight from our own renderer, corruption is not a threat).
    offset += 12 + length;
  }

  if (width === 0 || height === 0 || channels === 0) {
    throw new PngDecodeError('missing or empty IHDR');
  }
  if (idat.length === 0) throw new PngDecodeError('no IDAT chunk');

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (err) {
    throw new PngDecodeError(`IDAT inflate failed: ${(err as Error).message}`);
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new PngDecodeError('inflated data shorter than the scanlines it must hold');
  }

  // Defilter in place into `img` (spec § 9): each scanline is prefixed by one
  // filter-type byte; `left`/`up`/`upLeft` operate on DEFILTERED bytes.
  const img = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[(stride + 1) * y];
    const src = (stride + 1) * y + 1;
    const dst = stride * y;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const left = i >= channels ? img[dst + i - channels] : 0;
      const up = y > 0 ? img[dst + i - stride] : 0;
      const upLeft = y > 0 && i >= channels ? img[dst + i - stride - channels] : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + left; break;
        case 2: value = x + up; break;
        case 3: value = x + ((left + up) >> 1); break;
        case 4: value = x + paeth(left, up, upLeft); break;
        default: throw new PngDecodeError(`unknown scanline filter ${filter}`);
      }
      img[dst + i] = value & 0xff;
    }
  }

  if (channels === 4) return { width, height, pixels: img };

  // Expand RGB to RGBA so callers index one single layout.
  const rgba = Buffer.alloc(width * height * 4, 0xff);
  for (let p = 0; p < width * height; p++) {
    rgba[p * 4] = img[p * 3];
    rgba[p * 4 + 1] = img[p * 3 + 1];
    rgba[p * 4 + 2] = img[p * 3 + 2];
  }
  return { width, height, pixels: rgba };
}

/** [r, g, b, a] at (x, y); throws RangeError when out of bounds. */
export function pixelAt(png: DecodedPng, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height || !Number.isInteger(x) || !Number.isInteger(y)) {
    throw new RangeError(`pixel (${x}, ${y}) outside ${png.width}x${png.height}`);
  }
  const i = (y * png.width + x) * 4;
  return [png.pixels[i], png.pixels[i + 1], png.pixels[i + 2], png.pixels[i + 3]];
}
