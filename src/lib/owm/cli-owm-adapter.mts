// Concrete OwmRenderAdapter backed by the vendored cli-owm renderer
// (src/lib/vendor/cli-owm). This is the ONLY file in the project that
// imports the vendored `render()` — every SVG consumer goes through the
// OwmRenderAdapter interface, which is deliberately text-in / text-out so
// no vendored type ever crosses the boundary.
//
// SCOPE OF THE BOUNDARY — it covers RENDERING, not the vendored package as
// a whole. `parse()` is imported directly by the two strategies that need
// the OWM parse tree (`render/wardley-map/owm/parse/dsl.mts` and
// `render/wardley-map/text/lint/default.mts`), and that is on purpose:
// `parse()` returns `UnifiedWardleyMap`, a vendored type. Exposing it here
// would re-export that type through the adapter — moving the import while
// keeping the coupling — and would put a cli-owm-shaped method on an
// interface whose whole point is that a Playwright engine or a future
// official OWM package could implement it (see render-adapter.mts). Both
// parse consumers project the tree onto the canonical WardleyMap in the
// same file, so the vendored type never escapes them either.
//
// Canvas sizing: cli-owm's `render()` accepts width/height options
// but its own parser does NOT auto-feed `map.presentation.size` (the
// `size [w, h]` directive in the DSL) into them. We do that here so
// the rendered SVG honours the DSL canvas, matching what
// onlinewardleymaps.com does. When the DSL omits `size`, the parser
// returns `{ width: 0, height: 0 }` and we fall back to cli-owm's
// internal defaults (500×600) by passing no options.

import { parse, render } from '../vendor/cli-owm/index.mjs';
import type { OwmRenderAdapter } from './render-adapter.mjs';

export class CliOwmAdapter implements OwmRenderAdapter {
  render(dsl: string): string {
    const map = parse(dsl);
    const sz = map.presentation?.size;
    const opts: { width?: number; height?: number } = {};
    if (sz && sz.width  > 0) opts.width  = sz.width;
    if (sz && sz.height > 0) opts.height = sz.height;
    return render(map, opts);
  }
}
