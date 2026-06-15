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
import { MockWardleyIterationPurposeGenerateDefaultStrategy } from './wardley/iteration/purpose/generate/default.mock-strategy.mjs';
import { MockWardleyIterationPurposeAuditPurposeQualityDefaultStrategy } from './wardley/iteration/purpose/audit-purpose-quality/default.mock-strategy.mjs';
import { MockRenderWardleyMapOwmConfigDslStrategy } from './render/wardley-map/owm/config/dsl.mock-strategy.mjs';
import { MockRenderWardleyMapImageParseSvgStrategy } from './render/wardley-map/image/parse/svg.mock-strategy.mjs';
import { MockRenderWardleyMapImageParsePngStrategy } from './render/wardley-map/image/parse/png.mock-strategy.mjs';
import { MockRenderWardleyMapImageEmitPngStrategy } from './render/wardley-map/image/emit/png.mock-strategy.mjs';
import { MockRenderWardleyMapImageConfigSvgStrategy } from './render/wardley-map/image/config/svg.mock-strategy.mjs';
import { MockRenderWardleyMapImageConfigPngStrategy } from './render/wardley-map/image/config/png.mock-strategy.mjs';

export function registerMocks(registry: StrategyRegistry<BaseStrategy>): void {
  registry.register(MockCommonToolboxListEmitDefaultStrategy.method, MockCommonToolboxListEmitDefaultStrategy);
  registry.register(MockCommonToolboxWardleyJsonBoilerplateDefaultStrategy.method, MockCommonToolboxWardleyJsonBoilerplateDefaultStrategy);
  registry.register(MockWardleyMapConfigXAxisStandardStrategy.method, MockWardleyMapConfigXAxisStandardStrategy);
  registry.register(MockWardleyMapConfigXAxisCustomStrategy.method, MockWardleyMapConfigXAxisCustomStrategy);
  registry.register(MockWardleyMapConfigYAxisStandardStrategy.method, MockWardleyMapConfigYAxisStandardStrategy);
  registry.register(MockWardleyMapConfigYAxisCustomStrategy.method, MockWardleyMapConfigYAxisCustomStrategy);
  registry.register(MockWardleyMapValueChainGenerateDefaultStrategy.method, MockWardleyMapValueChainGenerateDefaultStrategy);
  registry.register(MockWardleyMapValueChainAuditDefaultStrategy.method, MockWardleyMapValueChainAuditDefaultStrategy);
  registry.register(MockWardleyMapValueChainReadPipelineOpportunityStrategy.method, MockWardleyMapValueChainReadPipelineOpportunityStrategy);
  registry.register(MockWardleyMapNodeGeneratePipelineFromComponentDefaultStrategy.method, MockWardleyMapNodeGeneratePipelineFromComponentDefaultStrategy);
  registry.register(MockWardleyMapNodeGenerateNodeFromPipelineDefaultStrategy.method, MockWardleyMapNodeGenerateNodeFromPipelineDefaultStrategy);
  registry.register(MockWardleyMapNodeGeneratePipelineDefaultStrategy.method, MockWardleyMapNodeGeneratePipelineDefaultStrategy);
  registry.register(MockWardleyMapNodeIdentifyPointOfChangeDefaultStrategy.method, MockWardleyMapNodeIdentifyPointOfChangeDefaultStrategy);
  registry.register(MockWardleyMapNodeClassifyPointOfChangeDefaultStrategy.method, MockWardleyMapNodeClassifyPointOfChangeDefaultStrategy);
  registry.register(MockWardleyMapNodeIdentifyMethodProjectManagementStrategy.method, MockWardleyMapNodeIdentifyMethodProjectManagementStrategy);
  registry.register(MockWardleyMapNodeIdentifyMethodBuyPolicyStrategy.method, MockWardleyMapNodeIdentifyMethodBuyPolicyStrategy);
  registry.register(MockWardleyMapClimateIdentifyDefaultStrategy.method, MockWardleyMapClimateIdentifyDefaultStrategy);
  registry.register(MockWardleyMapClimateIdentifyMethodIssuesDefaultStrategy.method, MockWardleyMapClimateIdentifyMethodIssuesDefaultStrategy);
  registry.register(MockWardleyMapClimateInertiaIdentificationDefaultStrategy.method, MockWardleyMapClimateInertiaIdentificationDefaultStrategy);
  registry.register(MockWardleyMapDoctrineOrientPathWhereToInvestDefaultStrategy.method, MockWardleyMapDoctrineOrientPathWhereToInvestDefaultStrategy);
  registry.register(MockWardleyMapDoctrineIdentifyTheMethodDefaultStrategy.method, MockWardleyMapDoctrineIdentifyTheMethodDefaultStrategy);
  registry.register(MockWardleyMapOutputReadWhereToInvestStrategy.method, MockWardleyMapOutputReadWhereToInvestStrategy);
  registry.register(MockWardleyMapOutputUpdateDefaultStrategy.method, MockWardleyMapOutputUpdateDefaultStrategy);
  registry.register(MockWardleyMapGameplayRecommendStrategyOverTheMapDefaultStrategy.method, MockWardleyMapGameplayRecommendStrategyOverTheMapDefaultStrategy);
  registry.register(MockWardleyMapZonageGeneratePstAnalysisStrategy.method, MockWardleyMapZonageGeneratePstAnalysisStrategy);
  registry.register(MockWardleyMapZonageGenerateTeamsStrategy.method, MockWardleyMapZonageGenerateTeamsStrategy);
  registry.register(MockWardleyMapZonageGenerateCoherentClusterStrategy.method, MockWardleyMapZonageGenerateCoherentClusterStrategy);
  registry.register(MockWardleyMapQualityAuditDefaultStrategy.method, MockWardleyMapQualityAuditDefaultStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyDoctrinalAnalysisDefaultStrategy.method, MockWardleyDoctrineSimonWardleyDoctrinalAnalysisDefaultStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyDoctrinalAnalysisPhaseAssessmentStrategy.method, MockWardleyDoctrineSimonWardleyDoctrinalAnalysisPhaseAssessmentStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyDoctrinalAnalysisThreeJudgementAssessmentStrategy.method, MockWardleyDoctrineSimonWardleyDoctrinalAnalysisThreeJudgementAssessmentStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyListListViewStrategy.method, MockWardleyDoctrineSimonWardleyListListViewStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyListKanbanViewStrategy.method, MockWardleyDoctrineSimonWardleyListKanbanViewStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyListKanbanViewGroupByPhaseStrategy.method, MockWardleyDoctrineSimonWardleyListKanbanViewGroupByPhaseStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyPstAnalysisPersonalStrategy.method, MockWardleyDoctrineSimonWardleyPstAnalysisPersonalStrategy);
  registry.register(MockWardleyDoctrineSimonWardleyPstAnalysisOrganisationStrategy.method, MockWardleyDoctrineSimonWardleyPstAnalysisOrganisationStrategy);
  registry.register(MockWardleyDoctrineWikiDoctrinalAnalysisDefaultStrategy.method, MockWardleyDoctrineWikiDoctrinalAnalysisDefaultStrategy);
  registry.register(MockWardleyDoctrineWikiListPhaseViewStrategy.method, MockWardleyDoctrineWikiListPhaseViewStrategy);
  registry.register(MockWardleyDoctrineWikiListKanbanViewStrategy.method, MockWardleyDoctrineWikiListKanbanViewStrategy);
  registry.register(MockWardleyDoctrineWikiDetailWikiUrlStrategy.method, MockWardleyDoctrineWikiDetailWikiUrlStrategy);
  registry.register(MockWardleyClimateSimonWardleyListListViewStrategy.method, MockWardleyClimateSimonWardleyListListViewStrategy);
  registry.register(MockWardleyClimateSimonWardleyListKanbanViewStrategy.method, MockWardleyClimateSimonWardleyListKanbanViewStrategy);
  registry.register(MockWardleyClimateSimonWardleyInertiaInertiaAnalysisStrategy.method, MockWardleyClimateSimonWardleyInertiaInertiaAnalysisStrategy);
  registry.register(MockWardleyClimateSimonWardleyInertiaListStrategy.method, MockWardleyClimateSimonWardleyInertiaListStrategy);
  registry.register(MockWardleyClimateWikiListListViewStrategy.method, MockWardleyClimateWikiListListViewStrategy);
  registry.register(MockWardleyClimateWikiListKanbanViewStrategy.method, MockWardleyClimateWikiListKanbanViewStrategy);
  registry.register(MockWardleyClimateWikiDetailWikiUrlStrategy.method, MockWardleyClimateWikiDetailWikiUrlStrategy);
  registry.register(MockWardleyGameplaySimonWardleyListListViewStrategy.method, MockWardleyGameplaySimonWardleyListListViewStrategy);
  registry.register(MockWardleyGameplayWikiListListViewStrategy.method, MockWardleyGameplayWikiListListViewStrategy);
  registry.register(MockWardleyGameplayWikiDetailWikiUrlStrategy.method, MockWardleyGameplayWikiDetailWikiUrlStrategy);
  registry.register(MockWardleyIterationStrategyCycleExplainDefaultStrategy.method, MockWardleyIterationStrategyCycleExplainDefaultStrategy);
  registry.register(MockWardleyIterationStrategyCycleGuideDefaultStrategy.method, MockWardleyIterationStrategyCycleGuideDefaultStrategy);
  registry.register(MockWardleyIterationWhyOfPurposeGuideDefaultStrategy.method, MockWardleyIterationWhyOfPurposeGuideDefaultStrategy);
  registry.register(MockWardleyIterationWhyOfMovementGuideDefaultStrategy.method, MockWardleyIterationWhyOfMovementGuideDefaultStrategy);
  registry.register(MockWardleyIterationObserveNextStepDefaultStrategy.method, MockWardleyIterationObserveNextStepDefaultStrategy);
  registry.register(MockWardleyIterationOrientNextStepDefaultStrategy.method, MockWardleyIterationOrientNextStepDefaultStrategy);
  registry.register(MockWardleyIterationDecideNextStepDefaultStrategy.method, MockWardleyIterationDecideNextStepDefaultStrategy);
  registry.register(MockWardleyIterationActNextStepDefaultStrategy.method, MockWardleyIterationActNextStepDefaultStrategy);
  registry.register(MockWardleyIterationPurposeGenerateDefaultStrategy.method, MockWardleyIterationPurposeGenerateDefaultStrategy);
  registry.register(MockWardleyIterationPurposeAuditPurposeQualityDefaultStrategy.method, MockWardleyIterationPurposeAuditPurposeQualityDefaultStrategy);
  registry.register(MockRenderWardleyMapOwmConfigDslStrategy.method, MockRenderWardleyMapOwmConfigDslStrategy);
  registry.register(MockRenderWardleyMapImageParseSvgStrategy.method, MockRenderWardleyMapImageParseSvgStrategy);
  registry.register(MockRenderWardleyMapImageParsePngStrategy.method, MockRenderWardleyMapImageParsePngStrategy);
  registry.register(MockRenderWardleyMapImageEmitPngStrategy.method, MockRenderWardleyMapImageEmitPngStrategy);
  registry.register(MockRenderWardleyMapImageConfigSvgStrategy.method, MockRenderWardleyMapImageConfigSvgStrategy);
  registry.register(MockRenderWardleyMapImageConfigPngStrategy.method, MockRenderWardleyMapImageConfigPngStrategy);
}