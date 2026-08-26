// Mocks registry (CP10).
//
// Registers every `*.mock-strategy.mts` file in the frameworks tree
// under its declared methodId. Mocks complement the real strategies
// migrated in CP3-CP6 so the v0.1.0 catalogue is exposed in full.
//
// Each entry below is a 1-line import + register. The list is canonical
// and reflects ast-schema.md v0.1.0 § 1.2. To remove a mock when a real
// strategy lands, delete the corresponding `.mock-strategy.mts` file
// and remove its two lines below.
//
// They register through `registerMock()`, not `register()` (CH-24). Behaviour
// is identical; what the second verb adds is PROVENANCE — `registry.catalogue()`
// then reports these methodIds as `mock`, and the `labre://methods` resource a
// third-party harness reads says so before it spends a call trusting the
// answer. This file is the only place that knows, so it is the only place that
// can declare it: promoting a mock to a real strategy means deleting its line
// here, which is exactly what flips the catalogue.

import type { StrategyRegistry } from '#core/registry/strategy-registry.mjs';
import type { BaseStrategy } from '#core/ast/base-strategy.mjs';

import { MockCommonToolboxListEmitDefaultStrategy } from './common/toolbox/list/emit/default.mock-strategy.mjs';
import { MockCommonToolboxWardleyJsonBoilerplateDefaultStrategy } from './common/toolbox/wardley/json-boilerplate/default.mock-strategy.mjs';
import { MockWardleyMapConfigXAxisStandardStrategy } from './wardley/map/config/x-axis/standard.mock-strategy.mjs';
import { MockWardleyMapConfigXAxisCustomStrategy } from './wardley/map/config/x-axis/custom.mock-strategy.mjs';
import { MockWardleyMapConfigYAxisStandardStrategy } from './wardley/map/config/y-axis/standard.mock-strategy.mjs';
import { MockWardleyMapConfigYAxisCustomStrategy } from './wardley/map/config/y-axis/custom.mock-strategy.mjs';
import { MockWardleyMapValueChainGenerateDefaultStrategy } from './wardley/map/value-chain/generate/default.mock-strategy.mjs';
import { MockWardleyMapValueChainAuditDefaultStrategy } from './wardley/map/value-chain/audit/default.mock-strategy.mjs';
// organized-y-position promoted to a real strategy (registered in chain/registry).
import { MockWardleyMapValueChainReadPipelineOpportunityStrategy } from './wardley/map/value-chain/read/pipeline-opportunity.mock-strategy.mjs';
import { MockWardleyMapNodeGeneratePipelineFromComponentDefaultStrategy } from './wardley/map/node/generate-pipeline-from-component/default.mock-strategy.mjs';
import { MockWardleyMapNodeGenerateNodeFromPipelineDefaultStrategy } from './wardley/map/node/generate-node-from-pipeline/default.mock-strategy.mjs';
import { MockWardleyMapNodeGeneratePipelineDefaultStrategy } from './wardley/map/node/generate-pipeline/default.mock-strategy.mjs';
import { MockWardleyMapNodeIdentifyPointOfChangeDefaultStrategy } from './wardley/map/node/identify-point-of-change/default.mock-strategy.mjs';
import { MockWardleyMapNodeClassifyPointOfChangeDefaultStrategy } from './wardley/map/node/classify-point-of-change/default.mock-strategy.mjs';
import { MockWardleyMapNodeIdentifyMethodProjectManagementStrategy } from './wardley/map/node/identify-method/project-management.mock-strategy.mjs';
import { MockWardleyMapNodeIdentifyMethodBuyPolicyStrategy } from './wardley/map/node/identify-method/buy-policy.mock-strategy.mjs';
import { MockWardleyMapClimateIdentifyDefaultStrategy } from './wardley/map/climate/identify/default.mock-strategy.mjs';
import { MockWardleyMapClimateIdentifyMethodIssuesDefaultStrategy } from './wardley/map/climate/identify-method-issues/default.mock-strategy.mjs';
import { MockWardleyMapClimateInertiaIdentificationDefaultStrategy } from './wardley/map/climate/inertia-identification/default.mock-strategy.mjs';
// position-value-chain-in-evolution removed: bulk map positioning is now expressed as a
// recipe fan-out (select-by-type:component → llm-direct), not a single strategy.
import { MockWardleyMapDoctrineOrientPathWhereToInvestDefaultStrategy } from './wardley/map/doctrine/orient-path-where-to-invest/default.mock-strategy.mjs';
import { MockWardleyMapDoctrineIdentifyTheMethodDefaultStrategy } from './wardley/map/doctrine/identify-the-method/default.mock-strategy.mjs';
import { MockWardleyMapOutputReadWhereToInvestStrategy } from './wardley/map/output/read/where-to-invest.mock-strategy.mjs';
import { MockWardleyMapOutputUpdateDefaultStrategy } from './wardley/map/output/update/default.mock-strategy.mjs';
import { MockWardleyMapGameplayRecommendStrategyOverTheMapDefaultStrategy } from './wardley/map/gameplay/recommend-strategy-over-the-map/default.mock-strategy.mjs';
import { MockWardleyMapZonageGeneratePstAnalysisStrategy } from './wardley/map/zonage/generate/pst-analysis.mock-strategy.mjs';
import { MockWardleyMapZonageGenerateTeamsStrategy } from './wardley/map/zonage/generate/teams.mock-strategy.mjs';
import { MockWardleyMapZonageGenerateCoherentClusterStrategy } from './wardley/map/zonage/generate/coherent-cluster.mock-strategy.mjs';
import { MockWardleyMapQualityAuditDefaultStrategy } from './wardley/map/quality/audit/default.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyDoctrinalAnalysisDefaultStrategy } from './wardley/doctrine/simon-wardley/doctrinal-analysis/default.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyDoctrinalAnalysisPhaseAssessmentStrategy } from './wardley/doctrine/simon-wardley/doctrinal-analysis/phase-assessment.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyDoctrinalAnalysisThreeJudgementAssessmentStrategy } from './wardley/doctrine/simon-wardley/doctrinal-analysis/three-judgement-assessment.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyListListViewStrategy } from './wardley/doctrine/simon-wardley/list/list-view.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyListKanbanViewStrategy } from './wardley/doctrine/simon-wardley/list/kanban-view.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyListKanbanViewGroupByPhaseStrategy } from './wardley/doctrine/simon-wardley/list/kanban-view-group-by-phase.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyPstAnalysisPersonalStrategy } from './wardley/doctrine/simon-wardley/pst-analysis/personal.mock-strategy.mjs';
import { MockWardleyDoctrineSimonWardleyPstAnalysisOrganisationStrategy } from './wardley/doctrine/simon-wardley/pst-analysis/organisation.mock-strategy.mjs';
import { MockWardleyDoctrineWikiDoctrinalAnalysisDefaultStrategy } from './wardley/doctrine/wiki/doctrinal-analysis/default.mock-strategy.mjs';
import { MockWardleyDoctrineWikiListPhaseViewStrategy } from './wardley/doctrine/wiki/list/phase-view.mock-strategy.mjs';
import { MockWardleyDoctrineWikiListKanbanViewStrategy } from './wardley/doctrine/wiki/list/kanban-view.mock-strategy.mjs';
import { MockWardleyDoctrineWikiDetailWikiUrlStrategy } from './wardley/doctrine/wiki/detail/wiki-url.mock-strategy.mjs';
import { MockWardleyClimateSimonWardleyListListViewStrategy } from './wardley/climate/simon-wardley/list/list-view.mock-strategy.mjs';
import { MockWardleyClimateSimonWardleyListKanbanViewStrategy } from './wardley/climate/simon-wardley/list/kanban-view.mock-strategy.mjs';
import { MockWardleyClimateSimonWardleyInertiaInertiaAnalysisStrategy } from './wardley/climate/simon-wardley/inertia/inertia-analysis.mock-strategy.mjs';
import { MockWardleyClimateSimonWardleyInertiaListStrategy } from './wardley/climate/simon-wardley/inertia/list.mock-strategy.mjs';
import { MockWardleyClimateWikiListListViewStrategy } from './wardley/climate/wiki/list/list-view.mock-strategy.mjs';
import { MockWardleyClimateWikiListKanbanViewStrategy } from './wardley/climate/wiki/list/kanban-view.mock-strategy.mjs';
import { MockWardleyClimateWikiDetailWikiUrlStrategy } from './wardley/climate/wiki/detail/wiki-url.mock-strategy.mjs';
import { MockWardleyGameplaySimonWardleyListListViewStrategy } from './wardley/gameplay/simon-wardley/list/list-view.mock-strategy.mjs';
import { MockWardleyGameplayWikiListListViewStrategy } from './wardley/gameplay/wiki/list/list-view.mock-strategy.mjs';
import { MockWardleyGameplayWikiDetailWikiUrlStrategy } from './wardley/gameplay/wiki/detail/wiki-url.mock-strategy.mjs';
import { MockWardleyIterationStrategyCycleExplainDefaultStrategy } from './wardley/iteration/strategy-cycle/explain/default.mock-strategy.mjs';
import { MockWardleyIterationStrategyCycleGuideDefaultStrategy } from './wardley/iteration/strategy-cycle/guide/default.mock-strategy.mjs';
import { MockWardleyIterationWhyOfPurposeGuideDefaultStrategy } from './wardley/iteration/why-of-purpose/guide/default.mock-strategy.mjs';
import { MockWardleyIterationWhyOfMovementGuideDefaultStrategy } from './wardley/iteration/why-of-movement/guide/default.mock-strategy.mjs';
import { MockWardleyIterationObserveNextStepDefaultStrategy } from './wardley/iteration/observe/next-step/default.mock-strategy.mjs';
import { MockWardleyIterationOrientNextStepDefaultStrategy } from './wardley/iteration/orient/next-step/default.mock-strategy.mjs';
import { MockWardleyIterationDecideNextStepDefaultStrategy } from './wardley/iteration/decide/next-step/default.mock-strategy.mjs';
import { MockWardleyIterationActNextStepDefaultStrategy } from './wardley/iteration/act/next-step/default.mock-strategy.mjs';
// purpose generate + audit-purpose-quality promoted to real strategies (registered in iteration/registry).
import { MockRenderWardleyMapOwmConfigDslStrategy } from './render/wardley-map/owm/config/dsl.mock-strategy.mjs';
import { MockRenderWardleyMapImageConfigSvgStrategy } from './render/wardley-map/image/config/svg.mock-strategy.mjs';
import { MockRenderWardleyMapImageConfigPngStrategy } from './render/wardley-map/image/config/png.mock-strategy.mjs';

export function registerMocks(registry: StrategyRegistry<BaseStrategy>): void {
  registry.registerMock(MockCommonToolboxListEmitDefaultStrategy.method, MockCommonToolboxListEmitDefaultStrategy);
  registry.registerMock(MockCommonToolboxWardleyJsonBoilerplateDefaultStrategy.method, MockCommonToolboxWardleyJsonBoilerplateDefaultStrategy);
  registry.registerMock(MockWardleyMapConfigXAxisStandardStrategy.method, MockWardleyMapConfigXAxisStandardStrategy);
  registry.registerMock(MockWardleyMapConfigXAxisCustomStrategy.method, MockWardleyMapConfigXAxisCustomStrategy);
  registry.registerMock(MockWardleyMapConfigYAxisStandardStrategy.method, MockWardleyMapConfigYAxisStandardStrategy);
  registry.registerMock(MockWardleyMapConfigYAxisCustomStrategy.method, MockWardleyMapConfigYAxisCustomStrategy);
  registry.registerMock(MockWardleyMapValueChainGenerateDefaultStrategy.method, MockWardleyMapValueChainGenerateDefaultStrategy);
  registry.registerMock(MockWardleyMapValueChainAuditDefaultStrategy.method, MockWardleyMapValueChainAuditDefaultStrategy);
  registry.registerMock(MockWardleyMapValueChainReadPipelineOpportunityStrategy.method, MockWardleyMapValueChainReadPipelineOpportunityStrategy);
  registry.registerMock(MockWardleyMapNodeGeneratePipelineFromComponentDefaultStrategy.method, MockWardleyMapNodeGeneratePipelineFromComponentDefaultStrategy);
  registry.registerMock(MockWardleyMapNodeGenerateNodeFromPipelineDefaultStrategy.method, MockWardleyMapNodeGenerateNodeFromPipelineDefaultStrategy);
  registry.registerMock(MockWardleyMapNodeGeneratePipelineDefaultStrategy.method, MockWardleyMapNodeGeneratePipelineDefaultStrategy);
  registry.registerMock(MockWardleyMapNodeIdentifyPointOfChangeDefaultStrategy.method, MockWardleyMapNodeIdentifyPointOfChangeDefaultStrategy);
  registry.registerMock(MockWardleyMapNodeClassifyPointOfChangeDefaultStrategy.method, MockWardleyMapNodeClassifyPointOfChangeDefaultStrategy);
  registry.registerMock(MockWardleyMapNodeIdentifyMethodProjectManagementStrategy.method, MockWardleyMapNodeIdentifyMethodProjectManagementStrategy);
  registry.registerMock(MockWardleyMapNodeIdentifyMethodBuyPolicyStrategy.method, MockWardleyMapNodeIdentifyMethodBuyPolicyStrategy);
  registry.registerMock(MockWardleyMapClimateIdentifyDefaultStrategy.method, MockWardleyMapClimateIdentifyDefaultStrategy);
  registry.registerMock(MockWardleyMapClimateIdentifyMethodIssuesDefaultStrategy.method, MockWardleyMapClimateIdentifyMethodIssuesDefaultStrategy);
  registry.registerMock(MockWardleyMapClimateInertiaIdentificationDefaultStrategy.method, MockWardleyMapClimateInertiaIdentificationDefaultStrategy);
  registry.registerMock(MockWardleyMapDoctrineOrientPathWhereToInvestDefaultStrategy.method, MockWardleyMapDoctrineOrientPathWhereToInvestDefaultStrategy);
  registry.registerMock(MockWardleyMapDoctrineIdentifyTheMethodDefaultStrategy.method, MockWardleyMapDoctrineIdentifyTheMethodDefaultStrategy);
  registry.registerMock(MockWardleyMapOutputReadWhereToInvestStrategy.method, MockWardleyMapOutputReadWhereToInvestStrategy);
  registry.registerMock(MockWardleyMapOutputUpdateDefaultStrategy.method, MockWardleyMapOutputUpdateDefaultStrategy);
  registry.registerMock(MockWardleyMapGameplayRecommendStrategyOverTheMapDefaultStrategy.method, MockWardleyMapGameplayRecommendStrategyOverTheMapDefaultStrategy);
  registry.registerMock(MockWardleyMapZonageGeneratePstAnalysisStrategy.method, MockWardleyMapZonageGeneratePstAnalysisStrategy);
  registry.registerMock(MockWardleyMapZonageGenerateTeamsStrategy.method, MockWardleyMapZonageGenerateTeamsStrategy);
  registry.registerMock(MockWardleyMapZonageGenerateCoherentClusterStrategy.method, MockWardleyMapZonageGenerateCoherentClusterStrategy);
  registry.registerMock(MockWardleyMapQualityAuditDefaultStrategy.method, MockWardleyMapQualityAuditDefaultStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyDoctrinalAnalysisDefaultStrategy.method, MockWardleyDoctrineSimonWardleyDoctrinalAnalysisDefaultStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyDoctrinalAnalysisPhaseAssessmentStrategy.method, MockWardleyDoctrineSimonWardleyDoctrinalAnalysisPhaseAssessmentStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyDoctrinalAnalysisThreeJudgementAssessmentStrategy.method, MockWardleyDoctrineSimonWardleyDoctrinalAnalysisThreeJudgementAssessmentStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyListListViewStrategy.method, MockWardleyDoctrineSimonWardleyListListViewStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyListKanbanViewStrategy.method, MockWardleyDoctrineSimonWardleyListKanbanViewStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyListKanbanViewGroupByPhaseStrategy.method, MockWardleyDoctrineSimonWardleyListKanbanViewGroupByPhaseStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyPstAnalysisPersonalStrategy.method, MockWardleyDoctrineSimonWardleyPstAnalysisPersonalStrategy);
  registry.registerMock(MockWardleyDoctrineSimonWardleyPstAnalysisOrganisationStrategy.method, MockWardleyDoctrineSimonWardleyPstAnalysisOrganisationStrategy);
  registry.registerMock(MockWardleyDoctrineWikiDoctrinalAnalysisDefaultStrategy.method, MockWardleyDoctrineWikiDoctrinalAnalysisDefaultStrategy);
  registry.registerMock(MockWardleyDoctrineWikiListPhaseViewStrategy.method, MockWardleyDoctrineWikiListPhaseViewStrategy);
  registry.registerMock(MockWardleyDoctrineWikiListKanbanViewStrategy.method, MockWardleyDoctrineWikiListKanbanViewStrategy);
  registry.registerMock(MockWardleyDoctrineWikiDetailWikiUrlStrategy.method, MockWardleyDoctrineWikiDetailWikiUrlStrategy);
  registry.registerMock(MockWardleyClimateSimonWardleyListListViewStrategy.method, MockWardleyClimateSimonWardleyListListViewStrategy);
  registry.registerMock(MockWardleyClimateSimonWardleyListKanbanViewStrategy.method, MockWardleyClimateSimonWardleyListKanbanViewStrategy);
  registry.registerMock(MockWardleyClimateSimonWardleyInertiaInertiaAnalysisStrategy.method, MockWardleyClimateSimonWardleyInertiaInertiaAnalysisStrategy);
  registry.registerMock(MockWardleyClimateSimonWardleyInertiaListStrategy.method, MockWardleyClimateSimonWardleyInertiaListStrategy);
  registry.registerMock(MockWardleyClimateWikiListListViewStrategy.method, MockWardleyClimateWikiListListViewStrategy);
  registry.registerMock(MockWardleyClimateWikiListKanbanViewStrategy.method, MockWardleyClimateWikiListKanbanViewStrategy);
  registry.registerMock(MockWardleyClimateWikiDetailWikiUrlStrategy.method, MockWardleyClimateWikiDetailWikiUrlStrategy);
  registry.registerMock(MockWardleyGameplaySimonWardleyListListViewStrategy.method, MockWardleyGameplaySimonWardleyListListViewStrategy);
  registry.registerMock(MockWardleyGameplayWikiListListViewStrategy.method, MockWardleyGameplayWikiListListViewStrategy);
  registry.registerMock(MockWardleyGameplayWikiDetailWikiUrlStrategy.method, MockWardleyGameplayWikiDetailWikiUrlStrategy);
  registry.registerMock(MockWardleyIterationStrategyCycleExplainDefaultStrategy.method, MockWardleyIterationStrategyCycleExplainDefaultStrategy);
  registry.registerMock(MockWardleyIterationStrategyCycleGuideDefaultStrategy.method, MockWardleyIterationStrategyCycleGuideDefaultStrategy);
  registry.registerMock(MockWardleyIterationWhyOfPurposeGuideDefaultStrategy.method, MockWardleyIterationWhyOfPurposeGuideDefaultStrategy);
  registry.registerMock(MockWardleyIterationWhyOfMovementGuideDefaultStrategy.method, MockWardleyIterationWhyOfMovementGuideDefaultStrategy);
  registry.registerMock(MockWardleyIterationObserveNextStepDefaultStrategy.method, MockWardleyIterationObserveNextStepDefaultStrategy);
  registry.registerMock(MockWardleyIterationOrientNextStepDefaultStrategy.method, MockWardleyIterationOrientNextStepDefaultStrategy);
  registry.registerMock(MockWardleyIterationDecideNextStepDefaultStrategy.method, MockWardleyIterationDecideNextStepDefaultStrategy);
  registry.registerMock(MockWardleyIterationActNextStepDefaultStrategy.method, MockWardleyIterationActNextStepDefaultStrategy);
  registry.registerMock(MockRenderWardleyMapOwmConfigDslStrategy.method, MockRenderWardleyMapOwmConfigDslStrategy);
  registry.registerMock(MockRenderWardleyMapImageConfigSvgStrategy.method, MockRenderWardleyMapImageConfigSvgStrategy);
  registry.registerMock(MockRenderWardleyMapImageConfigPngStrategy.method, MockRenderWardleyMapImageConfigPngStrategy);
}