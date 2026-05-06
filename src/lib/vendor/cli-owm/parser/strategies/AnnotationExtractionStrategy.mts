import * as ExtractionFunctions from '../extractionFunctions.mjs';
import {IParseStrategy} from '../types/base.mjs';
import BaseStrategyRunner from '../BaseStrategyRunner.mjs';

export default class AnnotationExtractionStrategy implements IParseStrategy {
    data: string;
    keyword: string;
    containerName: string;
    baseRunner: BaseStrategyRunner;
    constructor(data: string) {
        const config = {
            keyword: 'annotation',
            containerName: 'annotations',
            defaultAttributes: {increaseLabelSpacing: 0},
        };
        this.data = data;
        this.keyword = config.keyword;
        this.containerName = config.containerName;

        const extractionFuncs = [ExtractionFunctions.setNumber, ExtractionFunctions.setOccurances, ExtractionFunctions.setTextFromEnding];
        this.baseRunner = new BaseStrategyRunner(data, config, extractionFuncs);
    }

    apply() {
        const result = this.baseRunner.apply();
        const unpack = result[this.containerName];
        const returnables = unpack.filter((a: any) => a.occurances.length > 0);
        return {[this.containerName]: returnables, errors: []};
    }
}
