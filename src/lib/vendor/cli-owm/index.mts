import {UnifiedConverter} from './parser/UnifiedConverter.mjs';
import {IProvideFeatureSwitches} from './parser/types/base.mjs';
import {UnifiedWardleyMap} from './parser/types/unified/map.mjs';

export {render} from './render.mjs';
export type {RenderOptions} from './render.mjs';
export type {UnifiedWardleyMap} from './parser/types/unified/map.mjs';
export type {MapTheme} from './themes.mjs';
export {themes, Plain, Wardley, Handwritten, Dark, Colour} from './themes.mjs';

const defaultFeatureSwitches: IProvideFeatureSwitches = {
    enableDashboard: false,
    enableNewPipelines: true,
    enableLinkContext: true,
    enableAccelerators: true,
    enableDoubleClickRename: false,
    showToggleFullscreen: false,
    showMapToolbar: false,
    showMiniMap: false,
    allowMapZoomMouseWheel: false,
    enableModernComponents: true,
};

export function parse(mapText: string): UnifiedWardleyMap {
    const converter = new UnifiedConverter(defaultFeatureSwitches);
    return converter.parse(mapText);
}
