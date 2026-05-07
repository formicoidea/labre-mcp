// Zod schema for tool.config.json — runtime configuration of tool routing.
//
// Today this only configures `estimateEvolution`'s `auto` and `report` modes:
// for each detected component type (anchor / solution / capability), which
// strategy method id should the router pick (auto: one) or fan out across
// (report: many).
//
// Method ids are validated structurally only — actual existence in the
// strategy registry is checked at resolve time (lazy), not at boot.

import { z } from 'zod';

const CapacityIdRegex = /^write:capacity:[a-z][\w-]*$/;
const SolutionIdRegex = /^write:solution:[a-z][\w-]*$/;
// Anchor strategies are not registered with a method id (the function lives
// outside any registry); we accept a kebab-case logical name.
const AnchorIdRegex = /^[a-z][a-z0-9-]*$/;

const AutoMapSchema = z.object({
  anchor: z.string().regex(AnchorIdRegex),
  solution: z.string().regex(SolutionIdRegex),
  capability: z.string().regex(CapacityIdRegex),
}).strict();

const ReportMapSchema = z.object({
  anchor: z.array(z.string().regex(AnchorIdRegex)).min(1),
  solution: z.array(z.string().regex(SolutionIdRegex)).min(1),
  capability: z.array(z.string().regex(CapacityIdRegex)).min(1),
}).strict();

export const ToolConfigSchema = z.object({
  estimateEvolution: z.object({
    auto: AutoMapSchema,
    report: ReportMapSchema,
  }).strict(),
}).strict();

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
export type StrategyTypeKey = 'anchor' | 'solution' | 'capability';
export type RoutedMode = 'auto' | 'report';
