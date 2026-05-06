import * as ExtractionFunctions from '../extractionFunctions.mjs';
import {IParseStrategy, IProvideBaseElement, IProvideBaseStrategyRunnerConfig, IProvideDecoratorsConfig} from '../types/base.mjs';
import BaseStrategyRunner from '../BaseStrategyRunner.mjs';

export default class ExtendableComponentExtractionStrategy implements IParseStrategy {
    data: string;
    keyword: string;
    containerName: string;
    baseRunner: BaseStrategyRunner;
    constructor(
        data: string,
        config: IProvideBaseStrategyRunnerConfig,
        additionalExtractions: Array<(baseElement: IProvideBaseElement, element: string, config: IProvideDecoratorsConfig) => void>,
    ) {
        this.data = data;
        this.keyword = config.keyword;
        this.containerName = config.containerName;

        let extractionFuncs = [
            ExtractionFunctions.decorators,
            ExtractionFunctions.setCoords,
            ExtractionFunctions.setName,
            ExtractionFunctions.setInertia,
            ExtractionFunctions.setLabel,
            ExtractionFunctions.setEvolve,
        ];

        if (additionalExtractions !== null && additionalExtractions !== undefined) {
            extractionFuncs = additionalExtractions.concat(extractionFuncs);
        }

        this.baseRunner = new BaseStrategyRunner(data, config, extractionFuncs);
    }

    apply() {
        return this.baseRunner.apply();
    }
}
