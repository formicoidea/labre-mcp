import {
    EvolutionLabel,
    MapAccelerators,
    MapAnnotations,
    MapAttitudes,
    MapEvolution,
    MapMethods,
    MapNotes,
    MapParseError,
    MapPresentationStyle,
    MapUrls,
} from '../base.mjs';
import {EvolvedElementData, PipelineData, UnifiedComponent} from './components.mjs';
import {FlowLink} from './links.mjs';

export interface UnifiedWardleyMap {
    title: string;
    presentation: MapPresentationStyle;
    errors: Array<MapParseError>;
    components: UnifiedComponent[];
    anchors: UnifiedComponent[];
    submaps: UnifiedComponent[];
    markets: UnifiedComponent[];
    ecosystems: UnifiedComponent[];
    evolved: EvolvedElementData[];
    pipelines: PipelineData[];
    evolution: MapEvolution;
    links: FlowLink[];
    annotations: MapAnnotations[];
    notes: MapNotes[];
    methods: MapMethods[];
    urls: MapUrls[];
    attitudes: MapAttitudes[];
    accelerators: MapAccelerators[];
}

export interface GroupedComponents {
    components: UnifiedComponent[];
    anchors: UnifiedComponent[];
    submaps: UnifiedComponent[];
    markets: UnifiedComponent[];
    ecosystems: UnifiedComponent[];
}

export const createEmptyMap = (): UnifiedWardleyMap => {
    return {
        title: '',
        presentation: {} as MapPresentationStyle,
        errors: [],
        components: [],
        anchors: [],
        submaps: [],
        markets: [],
        ecosystems: [],
        evolved: [],
        pipelines: [],
        evolution: [] as EvolutionLabel[],
        links: [],
        annotations: [],
        notes: [],
        methods: [],
        urls: [],
        attitudes: [],
        accelerators: [],
    };
};

export const groupComponentsByType = (map: UnifiedWardleyMap): GroupedComponents => {
    return {
        components: map.components.filter(c => c.type === 'component'),
        anchors: map.anchors,
        submaps: map.submaps,
        markets: map.markets,
        ecosystems: map.ecosystems,
    };
};

export const getAllMapElements = (map: UnifiedWardleyMap): UnifiedComponent[] => {
    return [...map.components, ...map.anchors, ...map.submaps, ...map.markets, ...map.ecosystems];
};
