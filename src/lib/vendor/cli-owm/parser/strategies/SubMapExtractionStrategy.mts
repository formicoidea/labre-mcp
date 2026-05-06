import * as ExtractionFunctions from '../extractionFunctions.mjs';
import ExtendableComponentExtractionStrategy from './ExtendableComponentExtractionStrategy.mjs';
import {IParseStrategy} from '../types/base.mjs';

export default class SubMapExtractionStrategy implements IParseStrategy {
    data: string;
    parentStrategy: ExtendableComponentExtractionStrategy;
    constructor(data: string) {
        this.data = data;

        const additionalExtractions = [ExtractionFunctions.setRef];

        this.parentStrategy = new ExtendableComponentExtractionStrategy(
            data,
            {
                keyword: 'submap',
                containerName: 'submaps',
                defaultAttributes: {increaseLabelSpacing: 0},
            },
            additionalExtractions,
        );
    }

    apply() {
        return this.parentStrategy.apply();
    }
}
