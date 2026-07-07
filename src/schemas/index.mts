// Barrel for the schemas exposed to external consumers via the
// `@formicoidea/labre-mcp/schemas` package export (see package.json
// `exports["./schemas"]`). Keep this surface intentional — internal schemas
// stay reachable only through the `#schemas/*` subpath imports.

export {
  StrategyBundleManifestSchema,
  BundlePermissionSchema,
  BUNDLE_SLUG_REGEX,
  type StrategyBundleManifest,
  type BundlePermission,
} from './strategy-bundle.schema.mjs';
