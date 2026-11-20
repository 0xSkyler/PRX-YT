'use strict';
const assert = require('node:assert/strict');
const asar = require('@electron/asar');
const fs = require('node:fs');
const path = require('node:path');
const archive = path.resolve(process.argv[2] || path.join(__dirname, '../release-linux/linux-unpacked/resources/app.asar'));
assert.ok(fs.existsSync(archive), `Missing production archive: ${archive}`);
const entries = asar.listPackage(archive).map((stored) => ({ stored, file: stored.replaceAll('\\', '/') }));
const files = entries.map(({ file }) => file);
for (const { stored, file } of entries) {
    assert.ok(!file.includes('node_modules'), `Unexpected production dependency: ${file}`);
    assert.ok(!/\/tests\/|\/scripts\/|\/docs\/|ProxyValidator|ProxyScorer|\.exe$|\.node$/.test(file), `Unexpected packaged file: ${file}`);
    if (/\.(?:js|css|html)$/.test(file)) {
        const local = path.resolve(__dirname, '..', file.slice(1));
        assert.deepEqual(asar.extractFile(archive, stored.slice(1)), fs.readFileSync(local), `Stale packaged source: ${file}`);
    }
}
for (const expected of ['/src/main/main.js', '/src/main/YouTubePlaybackController.js', '/src/preload/preload.js', '/src/renderer/index.html']) assert.ok(files.includes(expected), `Missing ${expected}`);
const metadataEntry = entries.find(({ file }) => file === '/package.json');
assert.ok(metadataEntry, 'Missing /package.json');
const metadata = JSON.parse(asar.extractFile(archive, metadataEntry.stored.slice(1)));
const expectedMetadata = require('../package.json');
assert.deepEqual(
    { name: metadata.name, productName: metadata.productName, version: metadata.version },
    { name: expectedMetadata.name, productName: expectedMetadata.productName, version: expectedMetadata.version },
    `Packaged identity is not ${expectedMetadata.productName} v${expectedMetadata.version}`
);
assert.equal(metadata.name, 'prx-yt', 'Wrong packaged application name');
assert.equal(metadata.productName, 'PRX-YT', 'Wrong packaged product name');
console.log(`Production archive verified: ${files.length} entries, ${metadata.productName} v${metadata.version}, no npm dependency tree or legacy validator.`);
