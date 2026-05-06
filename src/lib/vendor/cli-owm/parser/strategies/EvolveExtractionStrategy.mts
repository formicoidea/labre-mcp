import * as ExtractionFunctions from '../extractionFunctions.mjs';
import {IParseStrategy} from '../types/base.mjs';
import BaseStrategyRunner from '../BaseStrategyRunner.mjs';

export default class EvolveExtractionStrategy implements IParseStrategy {
    data: string;
    keyword: string;
    containerName: string;
    baseRunner: BaseStrategyRunner;
    constructor(data: string) {
        const config = {
            keyword: 'evolve',
            containerName: 'evolved',
            defaultAttributes: {increaseLabelSpacing: 0},
        };
        this.data = data;
        this.keyword = config.keyword;
        this.containerName = config.containerName;

        const extractionFuncs = [ExtractionFunctions.decorators, ExtractionFunctions.setLabel, ExtractionFunctions.setNameWithMaturity];
        this.baseRunner = new BaseStrategyRunner(data, config, extractionFuncs);
    }

    apply() {
        return this.baseRunner.apply();
    }
}
