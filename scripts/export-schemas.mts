// Exports the labre-mcp data contract as JSON Schema files under schema/
// (checked in, served by the daemon at GET /schemas/<file>).
//
// Four files:
//   - wardley-map.schema.json  — copied verbatim from the renderer package
//     (@formicoidea/wardley-map-renderer is the source of truth, ast-schema.md
//     § 2.0 "Norme de communication"; its own $id is preserved).
//   - json-labre.schema.json   — generated from JsonLabreSchema; the
//     wardley.map subtree is replaced by a $ref to the copied renderer schema
//     so the canonical map shape is never duplicated.
//   - command-call.schema.json / command-result.schema.json — generated from
//     the Zod envelopes in src/schemas/command.schema.mts.
//
// Run: npm run schemas (from the repo root).

import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { JsonLabreSchema } from "#schemas/json-labre.schema.mjs";
import { CommandCallSchema, CommandResultSchema } from "#schemas/command.schema.mjs";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "schema");
// Resolvable in production — the daemon serves schema/ at this route.
const ID_BASE = "https://framework-mcp.labre.app/schemas/";
// ponytail: plain node_modules path (pnpm symlinks resolve it); the renderer's
// package `exports` map may not expose ./schema/*, so require.resolve is out.
const RENDERER_SCHEMA = path.join(
  ROOT,
  "node_modules/@formicoidea/wardley-map-renderer/schema/wardley-map.schema.json",
);

type JsonObject = Record<string, unknown>;

function toSchema(name: string, schema: z.ZodType): JsonObject {
  // unrepresentable "any": the renderer's map schema contains transforms, but
  // that whole subtree is $ref-swapped below; local envelopes are transform-free.
  return { ...z.toJSONSchema(schema, { unrepresentable: "any" }), $id: `${ID_BASE}${name}` };
}

await mkdir(OUT_DIR, { recursive: true });
await copyFile(RENDERER_SCHEMA, path.join(OUT_DIR, "wardley-map.schema.json"));

const jsonLabre = toSchema("json-labre.schema.json", JsonLabreSchema);
// Swap the inlined renderer map for a $ref (relative to $id → same route).
const wardley = (jsonLabre.properties as JsonObject | undefined)?.wardley as JsonObject | undefined;
const wardleyProps = wardley?.properties as JsonObject | undefined;
if (!wardleyProps?.map) {
  throw new Error("json-labre schema shape changed: properties.wardley.properties.map not found");
}
wardleyProps.map = { $ref: "./wardley-map.schema.json" };

const generated: Record<string, JsonObject> = {
  "json-labre.schema.json": jsonLabre,
  "command-call.schema.json": toSchema("command-call.schema.json", CommandCallSchema),
  "command-result.schema.json": toSchema("command-result.schema.json", CommandResultSchema),
};

for (const [name, doc] of Object.entries(generated)) {
  await writeFile(path.join(OUT_DIR, name), `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

process.stdout.write(
  `[export-schemas] wrote ${Object.keys(generated).length + 1} files to schema/\n`,
);
