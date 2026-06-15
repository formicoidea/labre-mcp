// labre-mcp's own install root — where shipped recipes live (ARCH-08).
//
// Resolution order:
//   1. `LABRE_SHIPPED_ROOT` env var (required when running from a bundled
//      single-file build where the source layout is flattened).
//   2. Auto-detection from `import.meta.url`: src/mcp/<file>.mts → up 2
//      levels = repo root. Works for `tsx src/...` (dev) and
//      `node dist/.../...` (prod) where the layout matches.
//
// Reading `process.env` here is the allowed top-level config exception to
// hard rule #20 (forbidden only at request time, not module load).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);

export const SHIPPED_ROOT =
  process.env.LABRE_SHIPPED_ROOT ?? resolve(dirname(__filename), '..', '..');
