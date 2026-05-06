// Concrete OwmRenderAdapter backed by the vendored cli-owm renderer
// (src/lib/vendor/cli-owm). This is the ONLY file in the project that
// imports the vendored renderer directly — every other consumer goes
// through the OwmRenderAdapter interface.

import { parse, render } from '../vendor/cli-owm/index.mjs';
import type { OwmRenderAdapter } from './render-adapter.mjs';

export class CliOwmAdapter implements OwmRenderAdapter {
  render(dsl: string): string {
    const map = parse(dsl);
    return render(map);
  }
}
