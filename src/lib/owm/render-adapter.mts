// Stable contract between the chain pipeline and ANY engine that can
// turn an OWM DSL string into a rendered SVG.
//
// Why an interface and not a direct call into the vendored cli-owm:
//   - keeps `src/work-on-value-chain/` decoupled from any specific
//     renderer ; the pipeline imports `OwmRenderAdapter`, never the
//     vendored module.
//   - lets us swap cli-owm for a Playwright-based engine, a future
//     official OWM npm package, or a mock in tests, with zero ripple.
//   - the contract is text-in / text-out (DSL → SVG) so it survives any
//     internal refactor of the renderer.
//
// V1 takes no options — sizing, theming and other knobs live inside
// the OWM DSL itself (`size [w, h]`, `style plain|wardley|...`). When
// a future need arises (e.g. forcing a specific bbox grid for
// regression tests), extend this interface deliberately rather than
// surface every renderer-specific knob.

export interface OwmRenderAdapter {
  /** Render an OWM DSL string to its SVG representation. Synchronous —
   *  cli-owm is in-process. Future async engines (e.g. Playwright)
   *  will introduce a separate async-flavoured interface rather than
   *  promote-everything-to-Promise here. */
  render(dsl: string): string;
}
