import {ComponentDecorator, ComponentLabel} from '../base.mjs';

export interface BaseMapElement {
    id: string;
    name: string;
    maturity: number;
    visibility: number;
    line?: number;
}

export interface LabelableElement {
    label: ComponentLabel;
    increaseLabelSpacing?: number;
}

export interface EvolvableElement {
    evolving?: boolean;
    evolved?: boolean;
    evolveMaturity?: number;
}

export interface DecoratedElement {
    decorators: ComponentDecorator;
    inertia?: boolean;
    pseudoComponent?: boolean;
    offsetY?: number;
    override?: string;
}

export interface UrlElement {
    url?: string | {url: string; [key: string]: any};
}

export interface UnifiedComponent extends BaseMapElement, LabelableElement, EvolvableElement, DecoratedElement, UrlElement {
    type: string;
    pipeline?: boolean;
}

export interface MapComponentData extends UnifiedComponent {
    type: 'component';
}

export interface MapAnchorData extends UnifiedComponent {
    type: 'anchor';
}

export interface MapSubmapData extends UnifiedComponent {
    type: 'submap';
}

export interface MapMarketData extends UnifiedComponent {
    type: 'market';
}

export interface MapEcosystemData extends UnifiedComponent {
    type: 'ecosystem';
}

export type ComponentData = MapComponentData | MapAnchorData | MapSubmapData | MapMarketData | MapEcosystemData;

export interface EvolvedElementData {
    name: string;
    maturity: number;
    label?: ComponentLabel;
    override?: string;
    line?: number;
    decorators?: ComponentDecorator;
    increaseLabelSpacing?: number;
}

export interface PipelineComponentData {
    id: string;
    name: string;
    maturity: number;
    visibility: number;
    line?: number;
    label?: ComponentLabel;
}

export interface PipelineData {
    id: string;
    name: string;
    visibility: number;
    line?: number;
    components: PipelineComponentData[];
    inertia?: boolean;
    hidden?: boolean;
    maturity1?: number;
    maturity2?: number;
}

export const isComponentType = (component: UnifiedComponent, type: string): boolean => {
    return component.type === type;
};

export const isComponent = (component: UnifiedComponent): component is MapComponentData => {
    return component.type === 'component';
};

export const isAnchor = (component: UnifiedComponent): component is MapAnchorData => {
    return component.type === 'anchor';
};

export const isSubmap = (component: UnifiedComponent): component is MapSubmapData => {
    return component.type === 'submap';
};

export const isMarket = (component: UnifiedComponent): component is MapMarketData => {
    return component.decorators?.market ?? false;
};

export const isEcosystem = (component: UnifiedComponent): component is MapEcosystemData => {
    return component.decorators?.ecosystem ?? false;
};

export const createUnifiedComponent = (
    partial: Partial<UnifiedComponent> & Pick<UnifiedComponent, 'id' | 'name' | 'type'>,
): UnifiedComponent => {
    const defaultDecorators = {
        ecosystem: false,
        market: false,
        buy: false,
        build: false,
        outsource: false,
    };

    const mergedDecorators = {
        ...defaultDecorators,
        ...(partial.decorators || {}),
    };

    return {
        maturity: 0,
        visibility: 0,
        label: {x: 0, y: 0},
        evolving: false,
        evolved: false,
        inertia: false,
        pseudoComponent: false,
        offsetY: 0,
        increaseLabelSpacing: 0,
        pipeline: false,
        ...partial,
        decorators: mergedDecorators,
    };
};

export const createEvolvedElement = (
    partial: Partial<EvolvedElementData> & Pick<EvolvedElementData, 'name' | 'maturity'>,
): EvolvedElementData => {
    return {
        label: {x: 0, y: 0},
        increaseLabelSpacing: 0,
        ...partial,
    };
};

export const createPipeline = (
    partial: Partial<PipelineData> & Pick<PipelineData, 'id' | 'name' | 'visibility' | 'components'>,
): PipelineData => {
    return {
        inertia: false,
        hidden: false,
        ...partial,
    };
};
