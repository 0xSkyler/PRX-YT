'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadTree } = require('./helpers.cjs');
const root = path.resolve(__dirname, '../src');
const seo = loadTree(root, {})('shared/seo.js');

test('Google remains the default and its URL format is unchanged', () => {
    assert.equal(seo.normalizeSearchEngine(), 'google');
    for (const page of [0, 1, 7]) {
        assert.equal(seo.buildSearchUrl('garment factory', page), seo.buildGoogleSearchUrl('garment factory', page));
    }
    assert.equal(seo.getSearchStart(seo.buildSearchUrl('query', 2)), '20');
});

test('Bing search pages use the selected engine and offset', () => {
    const first = new URL(seo.buildSearchUrl('garment factory', 0, 'bing'));
    const second = new URL(seo.buildSearchUrl('garment factory', 2, 'bing'));
    assert.equal(first.hostname, 'www.bing.com');
    assert.equal(first.searchParams.get('q'), 'garment factory');
    assert.equal(second.searchParams.get('first'), '21');
    assert.equal(seo.getSearchStart(first.href, 'bing'), '1');
    assert.equal(seo.getSearchStart(second.href, 'bing'), '21');
    assert.equal(seo.isSearchResultsUrl(first.href, 'bing'), true);
    assert.equal(seo.isSearchResultsUrl(first.href, 'google'), false);
});

test('DuckDuckGo HTML results use the selected engine and offset', () => {
    const first = new URL(seo.buildSearchUrl('garment factory', 0, 'duckduckgo'));
    const third = new URL(seo.buildSearchUrl('garment factory', 3, 'duckduckgo'));
    assert.equal(first.hostname, 'html.duckduckgo.com');
    assert.equal(first.searchParams.get('q'), 'garment factory');
    assert.equal(third.searchParams.get('s'), '30');
    assert.equal(seo.getSearchStart(first.href, 'duckduckgo'), '0');
    assert.equal(seo.getSearchStart(third.href, 'duckduckgo'), '30');
    assert.equal(seo.isSearchResultsUrl(first.href, 'duckduckgo'), true);
    assert.equal(seo.isSearchResultsUrl('https://duckduckgo.com/other?q=test', 'duckduckgo'), false);
});

test('only supported engines can be selected', () => {
    assert.throws(() => seo.normalizeSearchEngine('yahoo'), /Google, Bing, or DuckDuckGo/);
});
