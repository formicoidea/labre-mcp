import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {parse, render} from './index.mjs';

describe('cli-owm vendored smoke', () => {
    it('parses a minimal map with a title, style, and anchor', () => {
        const dsl = 'title test\nstyle plain\nanchor A [0.5, 0.5]';
        const map = parse(dsl);
        assert.equal(typeof map, 'object');
        assert.ok(map !== null);
        assert.ok(Array.isArray(map.anchors), 'map.anchors should be an array');
        const found = map.anchors.find((a) => a.name === 'A');
        assert.ok(found, 'expected an anchor named "A" in parsed map');
    });

    it('renders a parsed map to an SVG string', () => {
        const dsl = 'title test\nstyle plain\nanchor A [0.5, 0.5]';
        const map = parse(dsl);
        const svg = render(map, {});
        assert.equal(typeof svg, 'string');
        assert.ok(svg.startsWith('<svg'), `expected SVG to start with "<svg", got: ${svg.slice(0, 40)}`);
        assert.ok(svg.length >= 100, `expected SVG length >= 100, got ${svg.length}`);
    });

    it('parses + renders a multi-component DSL with 3 components and 2 links', () => {
        const dsl = [
            'title multi-component',
            'style plain',
            'component Customer [0.95, 0.5]',
            'component Website [0.85, 0.5]',
            'component Database [0.65, 0.5]',
            'Customer->Website',
            'Website->Database',
        ].join('\n');
        const map = parse(dsl);
        const svg = render(map, {});
        assert.ok(svg.includes('Customer'), 'SVG should contain "Customer"');
        assert.ok(svg.includes('Website'), 'SVG should contain "Website"');
        assert.ok(svg.includes('Database'), 'SVG should contain "Database"');
    });
});
