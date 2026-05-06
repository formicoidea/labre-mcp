import * as ExtractionFunctions from '../extractionFunctions.mjs';
import {IParseStrategy} from '../types/base.mjs';
import BaseStrategyRunner from '../BaseStrategyRunner.mjs';

export default class NoteExtractionStrategy implements IParseStrategy {
    data: string;
    keyword: string;
    containerName: string;
    baseRunner: BaseStrategyRunner;
    constructor(data: string) {
        this.data = data;
        this.keyword = 'note';
        this.containerName = 'notes';
        this.baseRunner = new BaseStrategyRunner(
            data,
            {
                keyword: this.keyword,
                containerName: this.containerName,
                defaultAttributes: {increaseLabelSpacing: 0},
            },
            [ExtractionFunctions.setText, ExtractionFunctions.setCoords],
        );
    }

    apply() {
        return this.baseRunner.apply();
    }
}
