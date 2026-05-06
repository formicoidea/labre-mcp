import {IProvideFeatureSwitches, WardleyMap} from './types/base.mjs';
import AcceleratorExtractionStrategy from './strategies/AcceleratorExtractionStrategy.mjs';
import AnchorExtractionStrategy from './strategies/AnchorExtractionStrategy.mjs';
import AnnotationExtractionStrategy from './strategies/AnnotationExtractionStrategy.mjs';
import AttitudeExtractionStrategy from './strategies/AttitudeExtractionStrategy.mjs';
import ComponentExtractionStrategy from './strategies/ComponentExtractionStrategy.mjs';
import EvolveExtractionStrategy from './strategies/EvolveExtractionStrategy.mjs';
import LinksExtractionStrategy from './strategies/LinksExtractionStrategy.mjs';
import NoteExtractionStrategy from './strategies/NoteExtractionStrategy.mjs';
import PipelineExtractionStrategy from './strategies/PipelineExtractionStrategy.mjs';
import PresentationExtractionStrategy from './strategies/PresentationExtractionStrategy.mjs';
import SubMapExtractionStrategy from './strategies/SubMapExtractionStrategy.mjs';
import TitleExtractionStrategy from './strategies/TitleExtractionStrategy.mjs';
import UrlExtractionStrategy from './strategies/UrlExtractionStrategy.mjs';
import XAxisLabelsExtractionStrategy from './strategies/XAxisLabelsExtractionStrategy.mjs';

export default class Converter {
    featureSwitches: IProvideFeatureSwitches;
    constructor(featureSwitches: IProvideFeatureSwitches) {
        this.featureSwitches = featureSwitches;
    }

    parse(data: string) {
        const t = this.stripComments(data);
        const strategies = [
            new TitleExtractionStrategy(t),
            new XAxisLabelsExtractionStrategy(t),
            new PresentationExtractionStrategy(t),
            new NoteExtractionStrategy(t),
            new AnnotationExtractionStrategy(t),
            new ComponentExtractionStrategy(t),
            new PipelineExtractionStrategy(t, this.featureSwitches),
            new EvolveExtractionStrategy(t),
            new AnchorExtractionStrategy(t),
            new LinksExtractionStrategy(t),
            new SubMapExtractionStrategy(t),
            new UrlExtractionStrategy(t),
            new AttitudeExtractionStrategy(t),
            new AcceleratorExtractionStrategy(t),
        ];
        const errorContainer = {errors: [] as any[]};

        const nullPresentation = {
            style: '',
            annotations: {visibility: 0, maturity: 0},
            size: {width: 0, height: 0},
        };
        let wardleyMap: WardleyMap = {
            links: [],
            anchors: [],
            evolved: [],
            pipelines: [],
            elements: [],
            annotations: [],
            notes: [],
            presentation: nullPresentation,
            evolution: [],
            submaps: [],
            urls: [],
            attitudes: [],
            accelerators: [],
            title: '',
            errors: [],
        };
        strategies.forEach(strategy => {
            const strategyResult = strategy.apply();
            wardleyMap = Object.assign(wardleyMap, strategyResult);
            if (strategyResult.errors && strategyResult.errors.length > 0)
                errorContainer.errors = errorContainer.errors.concat(strategyResult.errors);
        });
        return Object.assign(wardleyMap, errorContainer);
    }

    stripComments(data: string) {
        const doubleSlashRemoved = data.split('\n').map(line => {
            if (line.trim().indexOf('url') === 0) {
                return line;
            }
            return line.split('//')[0];
        });

        const lines = doubleSlashRemoved;
        const linesToKeep = [];
        let open = false;

        for (let i = 0; i < lines.length; i++) {
            const currentLine = lines[i];
            if (currentLine.indexOf('/*') > -1) {
                open = true;
                linesToKeep.push(currentLine.split('/*')[0].trim());
            } else if (open) {
                if (currentLine.indexOf('*/') > -1) {
                    open = false;
                    linesToKeep.push(currentLine.split('*/')[1].trim());
                }
            } else if (open === false) {
                linesToKeep.push(currentLine);
            }
        }

        return linesToKeep.join('\n');
    }
}
