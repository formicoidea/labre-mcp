import {UnifiedComponent} from './components.mjs';

export interface BaseLink {
    start: string;
    end: string;
    line?: number;
}

export interface FlowLink extends BaseLink {
    flow?: boolean;
    flowValue?: string;
    future?: boolean;
    past?: boolean;
    context?: string;
}

export interface ProcessedLink {
    link: FlowLink;
    startElement: UnifiedComponent;
    endElement: UnifiedComponent;
}

export interface ProcessedLinkGroup {
    name: string;
    links: ProcessedLink[];
}

export interface LinkExtractionResult {
    name: string;
    links: BaseLink[];
    startElements: UnifiedComponent[];
    endElements: UnifiedComponent[];
}

export const isFlowLink = (link: BaseLink): link is FlowLink => {
    return 'flow' in link || 'flowValue' in link;
};

export const createBaseLink = (partial: Partial<BaseLink> & Pick<BaseLink, 'start' | 'end'>): BaseLink => {
    return {
        ...partial,
    };
};

export const createFlowLink = (partial: Partial<FlowLink> & Pick<FlowLink, 'start' | 'end'>): FlowLink => {
    return {
        flow: false,
        future: false,
        past: false,
        ...partial,
    };
};

export const createProcessedLink = (link: FlowLink, startElement: UnifiedComponent, endElement: UnifiedComponent): ProcessedLink => {
    return {
        link,
        startElement,
        endElement,
    };
};
