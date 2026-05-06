import {MapTheme, Plain, themes} from './themes.mjs';
import {UnifiedWardleyMap} from './parser/types/unified/map.mjs';
import {UnifiedComponent} from './parser/types/unified/components.mjs';
import {FlowLink} from './parser/types/unified/links.mjs';
import {EvoOffsets} from './parser/defaults.mjs';

export interface RenderOptions {
    width?: number;
    height?: number;
    style?: string;
    theme?: MapTheme;
}

export function esc(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

export function maturityToX(maturity: number, width: number): number {
    return maturity * width;
}

export function visibilityToY(visibility: number, height: number): number {
    return (1 - visibility) * height;
}

export function render(map: UnifiedWardleyMap, options?: RenderOptions): string {
    const width = options?.width ?? 500;
    const height = options?.height ?? 600;

    let theme: MapTheme;
    if (options?.theme) {
        theme = options.theme;
    } else {
        const styleName = options?.style ?? map.presentation?.style ?? 'plain';
        theme = themes[styleName] ?? Plain;
    }

    const strokeWidth = theme.strokeWidth ?? 1;
    const pipelineArrowWidth = theme.pipelineArrowWidth ?? 5;
    const pipelineArrowHeight = theme.pipelineArrowHeight ?? 5;

    // Gather all components for link resolution
    const allComponents = [
        ...map.components,
        ...map.anchors,
        ...map.submaps,
        ...map.markets,
        ...map.ecosystems,
    ];

    // Build evolved name→maturity map for link resolution
    const evolvedMap = new Map<string, {maturity: number; visibility: number}>();
    for (const ev of map.evolved) {
        const source = allComponents.find(c => c.name === ev.name);
        if (source) {
            const displayName = ev.override || ev.name;
            evolvedMap.set(displayName, {
                maturity: ev.maturity,
                visibility: source.visibility,
            });
        }
    }

    const svgWidth = width + 105;
    const svgHeight = height + 137;

    const parts: string[] = [];

    // SVG root
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" ` +
        `viewBox="-35 -45 ${svgWidth} ${svgHeight}" version="1.1">`,
    );

    // Defs
    parts.push(renderDefs(theme, strokeWidth, pipelineArrowWidth, pipelineArrowHeight));

    // Background
    parts.push(renderBackground(width, height, theme));

    // Foundation (axes)
    parts.push(renderFoundation(map, width, height, theme, strokeWidth));

    // Attitudes
    for (const att of map.attitudes as any[]) {
        parts.push(renderAttitude(att, width, height, theme));
    }

    // Links
    for (const link of map.links) {
        parts.push(renderLink(link, allComponents, evolvedMap, width, height, theme));
    }

    // Evolution links (dashed lines from component to evolved position)
    for (const ev of map.evolved) {
        parts.push(renderEvolutionLink(ev, allComponents, width, height, theme));
    }

    // Anchors
    for (const anchor of map.anchors) {
        parts.push(renderAnchor(anchor, width, height, theme));
    }

    // Pipelines
    for (const pipeline of map.pipelines as any[]) {
        parts.push(renderPipeline(pipeline, allComponents, width, height, theme));
    }

    // Components
    for (const comp of map.components) {
        parts.push(renderComponent(comp, width, height, theme, map.pipelines as any[]));
    }

    // Submaps
    for (const comp of map.submaps) {
        parts.push(renderSubmap(comp, width, height, theme));
    }

    // Evolved components
    for (const ev of map.evolved) {
        parts.push(renderEvolvedComponent(ev, allComponents, width, height, theme));
    }

    // Inertia markers
    for (const comp of allComponents) {
        if (comp.inertia) {
            parts.push(renderInertia(comp.maturity, comp.visibility, width, height));
        }
    }

    // Notes
    for (const note of map.notes as any[]) {
        parts.push(renderNote(note, width, height, theme));
    }

    // Annotations
    parts.push(renderAnnotations(map, width, height, theme));

    // Accelerators
    for (const accel of map.accelerators as any[]) {
        parts.push(renderAccelerator(accel, width, height));
    }

    // Title
    if (map.title) {
        parts.push(`<text x="0" y="-10" font-weight="bold" font-size="20px" ` +
            `font-family="${esc(theme.fontFamily ?? '')}" fill="${theme.mapGridTextColor ?? theme.stroke ?? 'black'}">${esc(map.title)}</text>`);
    }

    parts.push('</svg>');
    return parts.join('\n');
}

function renderDefs(theme: MapTheme, strokeWidth: number, pipelineArrowWidth: number, pipelineArrowHeight: number): string {
    const evolvedStroke = theme.link?.evolvedStroke ?? 'red';
    const mainStroke = theme.stroke ?? 'black';
    const pipelineStroke = theme.pipelineArrowStroke ?? 'black';

    return `<defs>
  <linearGradient id="wardleyGradient" x1="0%" x2="100%" y1="0%" y2="0%">
    <stop offset="0%" style="stop-color:rgb(196,196,196);stop-opacity:1"/>
    <stop offset="0.3" style="stop-color:white;stop-opacity:1"/>
    <stop offset="0.7" style="stop-color:white"/>
    <stop offset="1" style="stop-color:rgb(196,196,196)"/>
  </linearGradient>
  <linearGradient id="arrowGradient" x1="0%" y1="0%" x2="100%" y2="0%">
    <stop offset="0%" style="stop-color:#ffffff;stop-opacity:1"/>
    <stop offset="40%" style="stop-color:#808080;stop-opacity:1"/>
    <stop offset="100%" style="stop-color:#808080;stop-opacity:1"/>
  </linearGradient>
  <pattern id="diagonalHatch" patternUnits="userSpaceOnUse" width="4" height="4">
    <path d="M 3,-1 l 2,2 M 0,0 l 4,4 M -1,3 l 2,2" stroke="grey" stroke-width="1" opacity=".5"/>
  </pattern>
  <marker id="arrow" markerWidth="12" markerHeight="12" refX="15" refY="0" viewBox="0 -5 10 10" orient="0">
    <path d="M0,-5L10,0L0,5" fill="${evolvedStroke}"/>
  </marker>
  <marker id="graphArrow" markerWidth="${12 / strokeWidth}" markerHeight="${12 / strokeWidth}" refX="9" refY="0" viewBox="0 -5 10 10" orient="0">
    <path d="M0,-5L10,0L0,5" fill="${mainStroke}"/>
  </marker>
  <marker id="pipelineArrow" markerWidth="${pipelineArrowWidth}" markerHeight="${pipelineArrowHeight}" refX="9" refY="0" viewBox="0 -5 10 10" orient="0">
    <path d="M0,-5L10,0L0,5" fill="${pipelineStroke}"/>
  </marker>
</defs>`;
}

function renderBackground(width: number, height: number, theme: MapTheme): string {
    const bg = theme.containerBackground ?? 'white';
    let fill: string;
    if (theme.className === 'wardley') {
        fill = 'url(#wardleyGradient)';
    } else {
        fill = bg;
    }
    return `<rect x="0" y="0" width="${width}" height="${height}" fill="${fill}" id="fillArea"/>`;
}

function renderFoundation(map: UnifiedWardleyMap, width: number, height: number, theme: MapTheme, strokeWidth: number): string {
    const stroke = theme.stroke ?? 'black';
    const dashArray = theme.strokeDasharray ?? '2,2';
    const sepStroke = theme.evolutionSeparationStroke ?? stroke;
    const textColor = theme.mapGridTextColor ?? stroke;
    const fontFamily = theme.fontFamily ?? '';

    const evolution = map.evolution && map.evolution.length === 4 ? map.evolution : [
        {line1: 'Genesis', line2: ''},
        {line1: 'Custom-Built', line2: ''},
        {line1: 'Product', line2: '(+rental)'},
        {line1: 'Commodity', line2: '(+utility)'},
    ];

    const custMark = (width / 20) * EvoOffsets.custom;
    const prodMark = (width / 20) * EvoOffsets.product;
    const commMark = (width / 20) * EvoOffsets.commodity;

    const parts: string[] = [];

    // Value chain axis (vertical, rotated)
    parts.push(`<g id="valueChain" transform="translate(0,${height}) rotate(270)">`);
    parts.push(`  <line x1="0" y1="0" x2="${height}" y2="0" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-dasharray="${dashArray}"/>`);
    // Evolution separation lines
    parts.push(`  <line x1="0" y1="${custMark}" x2="${height}" y2="${custMark}" stroke="${sepStroke}" stroke-dasharray="${dashArray}" stroke-width="1"/>`);
    parts.push(`  <line x1="0" y1="${prodMark}" x2="${height}" y2="${prodMark}" stroke="${sepStroke}" stroke-dasharray="${dashArray}" stroke-width="1"/>`);
    parts.push(`  <line x1="0" y1="${commMark}" x2="${height}" y2="${commMark}" stroke="${sepStroke}" stroke-dasharray="${dashArray}" stroke-width="1"/>`);
    parts.push(`  <text x="${height / 2}" y="-8" text-anchor="middle" font-size="12px" font-family="${esc(fontFamily)}" fill="${textColor}">Value Chain</text>`);
    parts.push('</g>');

    // Evolution axis (horizontal)
    parts.push(`<g id="Evolution" transform="translate(0,${height})">`);
    parts.push(`  <line x1="0" y1="0" x2="${width - 2}" y2="0" stroke="${stroke}" stroke-width="${strokeWidth}" marker-end="url(#graphArrow)"/>`);
    parts.push(`  <text x="0" y="1em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[0].line1)}</text>`);
    if (evolution[0].line2) parts.push(`  <text x="0" y="2em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[0].line2)}</text>`);
    parts.push(`  <text x="${custMark + 5}" y="1em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[1].line1)}</text>`);
    if (evolution[1].line2) parts.push(`  <text x="${custMark + 5}" y="2em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[1].line2)}</text>`);
    parts.push(`  <text x="${prodMark + 5}" y="1em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[2].line1)}</text>`);
    if (evolution[2].line2) parts.push(`  <text x="${prodMark + 5}" y="2em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[2].line2)}</text>`);
    parts.push(`  <text x="${commMark + 5}" y="1em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[3].line1)}</text>`);
    if (evolution[3].line2) parts.push(`  <text x="${commMark + 5}" y="2em" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">${esc(evolution[3].line2)}</text>`);
    parts.push(`  <text x="${width}" y="1.8em" text-anchor="end" font-size="11px" font-family="${esc(fontFamily)}" fill="${textColor}">Evolution</text>`);
    parts.push('</g>');

    return parts.join('\n');
}

function renderAttitude(att: any, width: number, height: number, theme: MapTheme): string {
    const x = maturityToX(att.maturity, width);
    const y = visibilityToY(att.visibility, height);
    const x2 = maturityToX(att.maturity2, width);
    const y2 = visibilityToY(att.visibility2, height);
    const w = x2 - x;
    const h = y2 - y;
    const attType = att.attitude as 'pioneers' | 'settlers' | 'townplanners';
    const style = theme.attitudes?.[attType];
    if (!style) return '';
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" ` +
        `fill="${style.fill ?? 'none'}" stroke="${style.stroke ?? 'none'}" ` +
        `fill-opacity="${style.fillOpacity ?? 0.4}" stroke-opacity="${style.strokeOpacity ?? 0.7}" ` +
        `stroke-width="${theme.attitudes?.strokeWidth ?? '5px'}"/>`;
}

export function resolveComponentPosition(
    name: string,
    allComponents: UnifiedComponent[],
    evolvedMap: Map<string, {maturity: number; visibility: number}>,
): {x: number; y: number; maturity: number; visibility: number; evolved: boolean} | null {
    // Check evolved components first
    const ev = evolvedMap.get(name);
    if (ev) {
        return {x: 0, y: 0, maturity: ev.maturity, visibility: ev.visibility, evolved: true};
    }
    const comp = allComponents.find(c => c.name === name);
    if (comp) {
        return {x: 0, y: 0, maturity: comp.maturity, visibility: comp.visibility, evolved: comp.evolved ?? false};
    }
    return null;
}

function renderLink(
    link: FlowLink,
    allComponents: UnifiedComponent[],
    evolvedMap: Map<string, {maturity: number; visibility: number}>,
    width: number, height: number,
    theme: MapTheme,
): string {
    const startPos = resolveComponentPosition(link.start, allComponents, evolvedMap);
    const endPos = resolveComponentPosition(link.end, allComponents, evolvedMap);
    if (!startPos || !endPos) return '';

    const x1 = maturityToX(startPos.maturity, width);
    const y1 = visibilityToY(startPos.visibility, height);
    const x2 = maturityToX(endPos.maturity, width);
    const y2 = visibilityToY(endPos.visibility, height);

    const isEvolved = startPos.evolved || endPos.evolved;
    const linkStroke = isEvolved ? (theme.link?.evolvedStroke ?? 'red') : (theme.link?.stroke ?? 'grey');
    const linkWidth = isEvolved ? (theme.link?.evolvedStrokeWidth ?? 1) : (theme.link?.strokeWidth ?? 1);

    const parts: string[] = [];
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${linkStroke}" stroke-width="${linkWidth}"/>`);

    // Flow overlay
    if (link.flow) {
        parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
            `stroke="${theme.link?.flow ?? '#99c5ee9e'}" stroke-width="${theme.link?.flowStrokeWidth ?? 10}"/>`);
    }

    // Context text
    if (link.context) {
        const cx = (x1 + x2) / 2;
        const cy = (y1 + y2) / 2;
        parts.push(`<text x="${cx}" y="${cy - 8}" text-anchor="middle" ` +
            `font-size="${theme.link?.contextFontSize ?? '11px'}" ` +
            `font-family="${esc(theme.fontFamily ?? '')}" fill="${theme.mapGridTextColor ?? theme.stroke ?? 'black'}">${esc(link.context)}</text>`);
    }

    return parts.join('\n');
}

function renderEvolutionLink(ev: any, allComponents: UnifiedComponent[], width: number, height: number, theme: MapTheme): string {
    const source = allComponents.find(c => c.name === ev.name);
    if (!source) return '';

    const x1 = maturityToX(source.maturity, width);
    const y1 = visibilityToY(source.visibility, height);
    const x2 = maturityToX(ev.maturity, width);
    const y2 = y1; // same visibility

    const evolvedStroke = theme.link?.evolvedStroke ?? 'red';
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ` +
        `stroke="${evolvedStroke}" stroke-width="${theme.link?.evolvedStrokeWidth ?? 1}" ` +
        `stroke-dasharray="5 5" marker-end="url(#arrow)"/>`;
}

function renderAnchor(anchor: UnifiedComponent, width: number, height: number, theme: MapTheme): string {
    const x = maturityToX(anchor.maturity, width);
    const y = visibilityToY(anchor.visibility, height);
    const fontSize = theme.anchor?.fontSize ?? '14px';
    const fill = theme.mapGridTextColor ?? theme.stroke ?? 'black';
    return `<text x="${x}" y="${y}" font-size="${fontSize}" font-weight="bold" ` +
        `font-family="${esc(theme.fontFamily ?? '')}" fill="${fill}" text-anchor="middle">${esc(anchor.name)}</text>`;
}

function renderPipeline(pipeline: any, allComponents: UnifiedComponent[], width: number, height: number, theme: MapTheme): string {
    if (pipeline.hidden) return '';
    const comp = allComponents.find(c => c.name === pipeline.name);
    if (!comp) return '';

    const y = visibilityToY(comp.visibility, height);
    const m1 = pipeline.maturity1 ?? 0.2;
    const m2 = pipeline.maturity2 ?? 0.8;
    const x1 = maturityToX(m1, width) - 15;
    const x2 = maturityToX(m2, width) + 15;
    const pipelineWidth = x2 - x1;
    const pipelineHeight = 22;
    const sw = theme.component?.pipelineStrokeWidth ?? 1;
    const str = theme.component?.stroke ?? 'black';

    return `<g transform="translate(${x1},${y - 11})">
  <line x1="0" y1="0" x2="${pipelineWidth}" y2="0" stroke-width="${sw}" stroke="${str}"/>
  <line x1="${pipelineWidth}" y1="0" x2="${pipelineWidth}" y2="${pipelineHeight}" stroke-width="${sw}" stroke="${str}"/>
  <line x1="${pipelineWidth}" y1="${pipelineHeight}" x2="0" y2="${pipelineHeight}" stroke-width="${sw}" stroke="${str}"/>
  <line x1="0" y1="${pipelineHeight}" x2="0" y2="0" stroke-width="${sw}" stroke="${str}"/>
</g>`;
}

function isPipelineComponent(comp: UnifiedComponent, pipelines: any[]): boolean {
    for (const p of pipelines) {
        if (p.name === comp.name && !p.hidden) return true;
    }
    return false;
}

function renderComponent(comp: UnifiedComponent, width: number, height: number, theme: MapTheme, pipelines: any[]): string {
    const x = maturityToX(comp.maturity, width);
    const y = visibilityToY(comp.visibility, height);
    const evolved = comp.evolved ?? false;
    const radius = theme.component?.radius ?? 5;
    const stroke = evolved ? (theme.component?.evolved ?? 'red') : (theme.component?.stroke ?? 'black');
    const fill = evolved ? (theme.component?.evolvedFill ?? 'white') : (theme.component?.fill ?? 'white');
    const sw = theme.component?.strokeWidth ?? 1;
    const textColor = evolved ? (theme.component?.evolvedTextColor ?? 'red') : (theme.component?.textColor ?? 'black');
    const fontSize = theme.component?.fontSize ?? '14px';
    const fontWeight = theme.component?.fontWeight ?? 'normal';
    const fontFamily = theme.fontFamily ?? '';

    const isPipeline = isPipelineComponent(comp, pipelines);

    const parts: string[] = [];

    if (isPipeline) {
        // Pipeline components get rectangles
        parts.push(`<rect x="${x - 5}" y="${y - 5}" width="10" height="10" ` +
            `fill="${fill}" stroke="${stroke}" stroke-width="${theme.component?.pipelineStrokeWidth ?? 1}"/>`);
    } else {
        // Normal components get circles
        parts.push(`<circle cx="${x}" cy="${y}" r="${radius}" ` +
            `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    }

    // Label
    const labelX = x + (comp.label?.x ?? 5);
    const labelY = y + (comp.label?.y ?? -10);
    parts.push(`<text x="${labelX}" y="${labelY}" font-size="${fontSize}" font-weight="${fontWeight}" ` +
        `font-family="${esc(fontFamily)}" fill="${textColor}">${esc(comp.name)}</text>`);

    return parts.join('\n');
}

function renderSubmap(comp: UnifiedComponent, width: number, height: number, theme: MapTheme): string {
    const x = maturityToX(comp.maturity, width);
    const y = visibilityToY(comp.visibility, height);
    const evolved = comp.evolved ?? false;
    const sm = theme.submap ?? theme.component;
    const radius = sm?.radius ?? 5;
    const stroke = evolved ? (sm?.evolved ?? 'red') : (sm?.stroke ?? 'black');
    const fill = evolved ? (sm?.evolvedFill ?? 'black') : (sm?.fill ?? 'black');
    const sw = sm?.strokeWidth ?? 1;
    const textColor = evolved ? (sm?.evolvedTextColor ?? 'red') : (sm?.textColor ?? 'black');
    const fontSize = sm?.fontSize ?? '13px';
    const fontFamily = theme.fontFamily ?? '';

    const parts: string[] = [];
    parts.push(`<rect x="${x - radius}" y="${y - radius}" width="${radius * 2}" height="${radius * 2}" ` +
        `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);

    const labelX = x + (comp.label?.x ?? 5);
    const labelY = y + (comp.label?.y ?? -10);
    parts.push(`<text x="${labelX}" y="${labelY}" font-size="${fontSize}" ` +
        `font-family="${esc(fontFamily)}" fill="${textColor}">${esc(comp.name)}</text>`);

    return parts.join('\n');
}

function renderEvolvedComponent(ev: any, allComponents: UnifiedComponent[], width: number, height: number, theme: MapTheme): string {
    const source = allComponents.find(c => c.name === ev.name);
    if (!source) return '';

    const x = maturityToX(ev.maturity, width);
    const y = visibilityToY(source.visibility, height);
    const radius = theme.component?.radius ?? 5;
    const stroke = theme.component?.evolved ?? 'red';
    const fill = theme.component?.evolvedFill ?? 'white';
    const sw = theme.component?.strokeWidth ?? 1;
    const textColor = theme.component?.evolvedTextColor ?? 'red';
    const fontSize = theme.component?.fontSize ?? '14px';
    const fontFamily = theme.fontFamily ?? '';

    const displayName = ev.override || ev.name;
    const labelX = x + (ev.label?.x ?? 5);
    const labelY = y + (ev.label?.y ?? -10);

    const parts: string[] = [];
    parts.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`);
    parts.push(`<text x="${labelX}" y="${labelY}" font-size="${fontSize}" ` +
        `font-family="${esc(fontFamily)}" fill="${textColor}">${esc(displayName)}</text>`);

    return parts.join('\n');
}

function renderInertia(maturity: number, visibility: number, width: number, height: number): string {
    const x = maturityToX(maturity, width);
    const y = visibilityToY(visibility, height);
    return `<line x1="${x}" y1="${y - 10}" x2="${x}" y2="${y + 10}" stroke="black" stroke-width="6"/>`;
}

function renderNote(note: any, width: number, height: number, theme: MapTheme): string {
    const x = maturityToX(note.maturity, width);
    const y = visibilityToY(note.visibility, height);
    const fontWeight = theme.note?.fontWeight ?? 'bold';
    const fontSize = theme.note?.fontSize ?? '12px';
    const fill = theme.note?.textColor ?? 'black';
    const fontFamily = theme.fontFamily ?? '';

    return `<text x="${x}" y="${y}" font-weight="${fontWeight}" font-size="${fontSize}" ` +
        `font-family="${esc(fontFamily)}" fill="${fill}">${esc(note.text)}</text>`;
}

function renderAnnotations(map: UnifiedWardleyMap, width: number, height: number, theme: MapTheme): string {
    if (!map.annotations || map.annotations.length === 0) return '';

    const parts: string[] = [];
    const annStyles = theme.annotation;
    const fontFamily = theme.fontFamily ?? '';

    // Render numbered circles at each occurrence position
    for (const ann of map.annotations as any[]) {
        if (!ann.occurances) continue;
        for (const occ of ann.occurances) {
            const x = maturityToX(occ.maturity, width);
            const y = visibilityToY(occ.visibility, height);
            parts.push(`<circle cx="${x}" cy="${y}" r="15" ` +
                `fill="${annStyles.fill}" stroke="${annStyles.stroke}" stroke-width="${annStyles.strokeWidth}"/>`);
            parts.push(`<text x="${x - 5}" y="${y + 5}" text-anchor="start" ` +
                `font-family="${esc(fontFamily)}" fill="${annStyles.text || annStyles.boxTextColour}">${ann.number}</text>`);
        }
    }

    // Render annotation box
    const annPos = map.presentation?.annotations ?? {visibility: 0.9, maturity: 0.1};
    const boxX = maturityToX(annPos.maturity, width);
    const boxY = visibilityToY(annPos.visibility, height);

    const lineHeight = 18;
    const boxWidth = 200;
    const boxHeight = (map.annotations.length + 1) * lineHeight + 8;

    // Box background
    parts.push(`<rect x="${boxX - 2}" y="${boxY - 2}" width="${boxWidth}" height="${boxHeight}" ` +
        `fill="${annStyles.boxFill}" stroke="${annStyles.boxStroke}" stroke-width="${annStyles.boxStrokeWidth}"/>`);

    // "Annotations:" header
    parts.push(`<text x="${boxX + 2}" y="${boxY + lineHeight}" text-decoration="underline" ` +
        `font-family="${esc(fontFamily)}" fill="${annStyles.text || annStyles.boxTextColour}" font-size="13px">Annotations:</text>`);

    // Individual annotation entries
    for (let i = 0; i < map.annotations.length; i++) {
        const ann = map.annotations[i] as any;
        const ty = boxY + (i + 2) * lineHeight;
        parts.push(`<text x="${boxX + 2}" y="${ty}" ` +
            `font-family="${esc(fontFamily)}" fill="${annStyles.boxTextColour}" font-size="13px"> ${ann.number}. ${esc(ann.text)}</text>`);
    }

    return parts.join('\n');
}

function renderAccelerator(accel: any, width: number, height: number): string {
    const x = maturityToX(accel.maturity, width);
    const y = visibilityToY(accel.visibility, height);
    const isDeaccel = accel.deaccelerator;
    const rotation = isDeaccel ? ' rotate(180,25,25)' : '';

    return `<g transform="translate(${x - 25},${y - 25})${rotation}">
  <g opacity="0.8" fill="url(#arrowGradient)">
    <path d="m25.5 6 18 18 -18 18v-9H9a1.5 1.5 0 0 1 -1.5 -1.5V16.5a1.5 1.5 0 0 1 1.5 -1.5h16.5Z"/>
  </g>
  <path d="m44.561 22.939 -18 -18A1.5 1.5 0 0 0 24 6v7.5H9a3.003 3.003 0 0 0 -3 3v15a3.003 3.003 0 0 0 3 3h15v7.5a1.5 1.5 0 0 0 2.561 1.06l18 -18a1.5 1.5 0 0 0 0 -2.121ZM27 38.379V33a1.5 1.5 0 0 0 -1.5 -1.5H9V16.5h16.5a1.5 1.5 0 0 0 1.5 -1.5V9.621L41.379 24Z"/>
</g>`;
}
