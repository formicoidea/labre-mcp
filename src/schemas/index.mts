// Barrel for the schemas exposed to external consumers via the
// `@formicoidea/labre-mcp/schemas` package export (see package.json
// `exports["./schemas"]`). Keep this surface intentional — internal schemas
// stay reachable only through the `#schemas/*` subpath imports.

// BREAKING for `@formicoidea/labre-mcp/schemas` consumers: `BundlePermissionSchema`
// and `BundlePermission` are removed with the field they described (ARCH-29 A4).
// labre-admin must drop its permissions picker; a manifest that still sends the
// key keeps loading — the schema accepts and discards it.
export {
  StrategyBundleManifestSchema,
  BUNDLE_SLUG_REGEX,
  type StrategyBundleManifest,
} from './strategy-bundle.schema.mjs';
