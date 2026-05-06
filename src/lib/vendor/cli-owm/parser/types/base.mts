export interface Link {
    start: string;
    end: string;
}

export interface MapElement {
    inertia: boolean;
    name: string;
    id: string;
    visibility: number;
    type: string;
    evolveMaturity?: number;
    maturity: number;
    evolving: boolean;
    evolved: boolean;
    pseudoComponent: boolean;
    offsetY: number;
    label: ComponentLabel;
    override?: any;
    line?: any;
    decorators?: ComponentDecorator;
    increaseLabelSpacing: number;
    pipeline?: boolean;
    url?: {name: string; url: string};
}

export interface ComponentLabel {
    x: number;
    y: number;
}

export interface NamedComponent {
    name: string;
    label: ComponentLabel;
    line: number;
}

export interface MapLinks extends Link {
    flow: boolean;
    future: boolean;
    past: boolean;
    context: string;
    flowValue: string;
}

export interface MapAnchors extends NamedComponent {
    evolved: boolean;
    maturity: number;
    visibility: number;
    id: string;
    type: string;
    inertia: boolean;
    decorators: ComponentDecorator;
    increaseLabelSpacing: number;
    pseudoComponent: boolean;
    offsetY: number;
    evolving: boolean;
}

export type MapEvolved = Record<string, unknown>;
export type MapPipelines = Record<string, unknown>;
export type MapComponents = NamedComponent;

export interface MapAnnotation {
    maturity: number;
    number: number;
    visibility: number;
    text: string;
}

export interface MapAnnotations {
    number: number;
    occurances: Array<MapAnnotation>;
    text: string;
}

export interface MapNotes {
    id: string;
    text: string;
    visibility: number;
    maturity: number;
    line: number;
}

export type MapEvolution = Array<EvolutionLabel>;

export interface MapMethods {
    id?: number | string;
    line?: number;
    increaseLabelSpacing?: number;
    name: string;
    decorators: ComponentDecorator;
}

export type MapSubmaps = NamedComponent;
export type MapMarkets = NamedComponent;
export type MapEcosystems = Record<string, unknown>;

export interface MapUrls {
    name: string;
    url: string;
}

export type MapAttitudes = Record<string, unknown>;

export interface MapAccelerators {
    id: string;
    name: string;
    maturity: number;
    visibility: number;
    offsetY: number;
    evolved: boolean;
    deaccelerator: boolean;
    line: number;
}

export interface WardleyMap {
    presentation: MapPresentationStyle;
    links: MapLinks[];
    anchors: MapAnchors[];
    evolved: MapEvolved[];
    pipelines: MapPipelines[];
    elements: MapComponents[];
    annotations: MapAnnotations[];
    notes: MapNotes[];
    evolution: MapEvolution;
    title: string;
    submaps: MapSubmaps[];
    urls: MapUrls[];
    attitudes: MapAttitudes[];
    accelerators: MapAccelerators[];
    errors: Array<MapParseError>;
}

export interface EvolutionLabel {
    line1: string;
    line2: string;
}

export interface ComponentDecorator {
    ecosystem: boolean;
    market: boolean;
    buy: boolean;
    build: boolean;
    outsource: boolean;
}

export interface IParseStrategy {
    apply(): any;
}

export interface IProvideDefaultAttributes {
    increaseLabelSpacing: number;
}

export interface IProvideBaseElement {
    id: number;
    line: number;
}

export interface IProvideDecoratorsConfig {
    keyword: string;
    containerName: string;
    config?: IProvideBaseStrategyRunnerConfig;
}

export interface IProvideBaseStrategyRunnerConfig {
    containerName: string;
    keyword: string;
    defaultAttributes: IProvideDefaultAttributes;
}

export interface MapComponent {
    maturity: number;
    visibility: number;
}

export interface IPipelineComponent extends IProvideBaseElement {
    components: MapComponent[];
    maturity1?: number;
    maturity2?: number;
    hidden: boolean;
}

export interface MapAnnotationsPosition {
    visibility: number;
    maturity: number;
}

export interface MapSize {
    width: number;
    height: number;
}

export interface MapPresentationStyle {
    style: string;
    annotations: MapAnnotationsPosition;
    size: MapSize;
}

export interface MapParseError {
    line: number;
    name: string;
}

export interface IProvideFeatureSwitches {
    enableDashboard: boolean;
    enableNewPipelines: boolean;
    enableLinkContext: boolean;
    enableAccelerators: boolean;
    enableDoubleClickRename: boolean;
    showToggleFullscreen: boolean;
    showMapToolbar: boolean;
    showMiniMap: boolean;
    allowMapZoomMouseWheel: boolean;
    enableModernComponents: boolean;
}
