// BigQuery patent constants.
//
// Extracted from bigquery-patent-source.mts to break the circular
// dependency it formed with bigquery-query-builders.mts (the source
// owned the constants while the query builders imported them, and the
// source in turn imported `buildAllQueries` from the builders module).
//
// Constants live here as the shared leaf both files depend on.

/** Default minimum filing year — limits scan size and cost. */
export const DEFAULT_MIN_YEAR = 2000;

/** Maximum patent families to scan per query (cost control). */
export const DEFAULT_MAX_PATENTS = 100_000;

/**
 * Patent term in years (US post-1995 = 20 years from filing).
 * Used by the expiration query to classify expired vs active patents.
 */
export const PATENT_TERM_YEARS = 20;
