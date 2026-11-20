'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const asar = require('@electron/asar');
const manifest = require('../docs/recovery-manifest.json');
const root = path.resolve(__dirname, '..');
const destination = path.resolve(process.argv[2] || path.join(root, '.recovery/reference'));
const installerUrl = 'https://raw.githubusercontent.com/0xSkyler/ProxyDesk/b7c3c93ce89d753ad5b25c72ca2f5cabef6fe951/tests/fixtures/recovery/DOM-v0.5.4-MultiKeyword-AllWorking-Setup%281%29.exe';
const maximumInstallerBytes = 128 * 1024 * 1024;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function assertDestinationAbsent() {
    if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
}
function verifyInstaller(file) {
    if (hash(file) !== manifest.installerSha256) throw new Error(`Reference installer hash mismatch: ${file}`);
    return file;
}
async function resolveInstaller() {
    const local = path.join(root, manifest.installer);
    if (fs.existsSync(local)) return verifyInstaller(local);
    const cacheDirectory = path.join(root, '.recovery/fixtures');
    const cached = path.join(cacheDirectory, path.basename(manifest.installer));
    if (fs.existsSync(cached)) return verifyInstaller(cached);
    fs.mkdirSync(cacheDirectory, { recursive: true });
    const temporary = fs.mkdtempSync(path.join(cacheDirectory, 'download-'));
    const partial = path.join(temporary, 'installer.part');
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('Historical installer download timed out after 120 seconds.')), 120_000);
    deadline.unref();
    try {
        console.log('Downloading the optional historical recovery fixture from its immutable source revision.');
        const response = await fetch(installerUrl, { signal: controller.signal, redirect: 'error' });
        if (!response.ok || !response.body) throw new Error(`Historical installer download failed: HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > maximumInstallerBytes)
            throw new Error('Historical installer exceeds the 128 MiB download limit.');
        let received = 0;
        const boundedStream = new Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                callback(received > maximumInstallerBytes
                    ? new Error('Historical installer exceeds the 128 MiB download limit.') : null, chunk);
            }
        });
        await pipeline(Readable.fromWeb(response.body), boundedStream,
            fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: controller.signal });
        verifyInstaller(partial);
        // Concurrent optional recovery commands may have completed the same
        // immutable download. Never replace an existing, unverified cache file.
        if (fs.existsSync(cached)) verifyInstaller(cached);
        else {
            try { fs.linkSync(partial, cached); }
            catch (error) {
                if (error.code !== 'EEXIST') throw error;
                verifyInstaller(cached);
            }
        }
        return cached;
    } finally {
        clearTimeout(deadline);
        controller.abort();
        fs.rmSync(temporary, { recursive: true, force: true });
    }
}
function files(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
        ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
async function recover() {
    assertDestinationAbsent();
    const installer = await resolveInstaller();
    // The download can take time; do not overwrite a destination created while
    // awaiting it. Reserve the destination exclusively immediately before use.
    assertDestinationAbsent();
    const temporary = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'prx-yt-recovery-'));
    const seven = require('7zip-bin').path7za;
    try {
        fs.chmodSync(seven, 0o755);
        execFileSync(seven, ['x', installer, `-o${temporary}/installer`, '-y'], { stdio: 'pipe' });
        let archive = files(`${temporary}/installer`).find((file) => path.basename(file) === 'app.asar');
        if (!archive) {
            const nested = files(`${temporary}/installer`).filter((file) => path.basename(file) === 'app-64.7z');
            if (nested.length !== 1) throw new Error('Expected exactly one app-64.7z');
            execFileSync(seven, ['x', nested[0], `-o${temporary}/unpacked`, '-y'], { stdio: 'pipe' });
            archive = files(`${temporary}/unpacked`).find((file) => path.basename(file) === 'app.asar');
        }
        if (!archive) throw new Error('Missing app.asar');
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.mkdirSync(destination); // EEXIST also rejects a concurrent recovery.
        asar.extractAll(archive, destination);
        const metadata = JSON.parse(fs.readFileSync(path.join(destination, 'package.json')));
        if (metadata.version !== '0.5.4' || metadata.main !== 'dist/main/main.js') throw new Error('Unexpected reference metadata');
        for (const [file, expected] of Object.entries(manifest.files)) {
            if (hash(path.join(destination, file)) !== expected) throw new Error(`Reference hash mismatch: ${file}`);
        }
        console.log(`Verified ${Object.keys(manifest.files).length} reference files in ${destination}`);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
recover().catch(error => { console.error(error.message); process.exitCode = 1; });
