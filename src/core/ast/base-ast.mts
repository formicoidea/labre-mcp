// Common contract shared by every per-tool AST in labre-mcp.
// A tool AST is the typed JSON state representation of an artefact
// (chain map, evolution analysis, etc.) that flows between strategies.

export interface BaseAST {
  readonly schemaVersion: string;
}
