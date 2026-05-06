import * as ExtractionFunctions from '../extractionFunctions.mjs';
import {IParseStrategy} from '../types/base.mjs';
import BaseStrategyRunner from '../BaseStrategyRunner.mjs';

export default class UrlExtractionStrategy implements IParseStrategy {
    data: string;
    keyword: string;
    containerName: string;
    baseRunner: BaseStrategyRunner;
    constructor(data: string) {
        this.data = data;
        this.keyword = 'url';
        this.containerName = 'urls';
        this.baseRunner = new BaseStrategyRunner(
            data,
            {
                keyword: this.keyword,
                containerName: this.containerName,
                defaultAttributes: {increaseLabelSpacing: 0},
            },
            [ExtractionFunctions.setName, ExtractionFunctions.setUrl],
        );
    }

    apply() {
        return this.baseRunner.apply();
    }
}
