// Canonical `wardley.map` interchange type — RE-EXPORTED from the renderer
// package so labre's schema is `===` to the renderer's source of truth
// (`@formicoidea/wardley-map-renderer`, ast-schema.md § 2.0 norme de
// communication). Never redefine the shape here: the package's Zod schema is
// generated from its `src/schema.ts` and drives the renderer directly.
//
// Analytical fields (per-node confidence/rationale) are NOT part of this map
// (the renderer only carries `position.evolution.range` for uncertainty); they
// live in the JSON-labre `envelope` (signals/insights), referenced by component id.

export {
  WardleyMapSchema,
  ComponentSchema,
  RelationSchema,
  PositionSchema,
  EvolutionFieldSchema,
  VisibilityFieldSchema,
  EvolvesToSchema,
  PipelineGeometrySchema,
  MethodSchema,
  LabelSchema,
  LabelPositionSchema,
  ComponentTypeEnum,
  SubtypeEnum,
  NatureEnum,
  RelationTypeEnum,
  FlowSchema,
  type WardleyMap,
  type Component,
  type Relation,
  type Subtype,
  type Nature,
  type Method,
  type Label,
  type LabelPosition,
  type Position,
  type EvolutionField,
  type VisibilityField,
  type EvolvesTo,
  type PipelineGeometry,
  type Flow,
  type RelationType,
} from '@formicoidea/wardley-map-renderer';
