import * as ExtractionFunctions from '../extractionFunctions.mjs';
import {IParseStrategy} from '../types/base.mjs';
import BaseStrategyRunner from '../BaseStrategyRunner.mjs';

export default class AnchorExtractionStrategy implements IParseStrategy {
    data: string;
    keyword: string;
    containerName: string;
    baseRunner: BaseStrategyRunner;
    constructor(data: string) {
        const config = {
            keyword: 'anchor',
            containerName: 'anchors',
            defaultAttributes: {increaseLabelSpacing: 0},
        };
        this.data = data;
        this.keyword = config.keyword;
        this.containerName = config.containerName;
        this.baseRunner = new BaseStrategyRunner(data, config, [ExtractionFunctions.setName, ExtractionFunctions.setCoords]);
    }

    apply() {
        return this.baseRunner.apply();
    }
}
