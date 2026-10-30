'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
    let meta = { charIndex: [], presets: [], activePartitions: {} };
    let parts = {}, saves = [], server = false, failSave = false, failUpload = false;
    let uploads = 0, simultaneous = 0, maximum = 0;
    const prefix = '/api/plugins/outfit-manager/images/';
    const db = {
        loadMeta: () => meta,
        loadPartition: key => parts[key] || { outfits: [], accessories: [], categories: [], accCategories: [], activeIds: [] },
        currentUserPartKey: () => 'user:chosen-preset',
        saveImportPartition: async (key, part, registration) => {
            if (failSave) throw new Error('quota');
            saves.push(key); parts[key] = part;
            if (registration) {
                const list = registration.kind === 'preset' ? meta.presets : meta.charIndex;
                if (!list.some(e => e.id === registration.entry.id)) list.push(registration.entry);
            }
        },
        isServerMode: () => server,
        getImageUrlPrefix: () => prefix,
        uploadImage: (value, cb) => {
            uploads++; simultaneous++; maximum = Math.max(maximum, simultaneous);
            setTimeout(() => { simultaneous--; cb(null, failUpload ? value : prefix + uploads); }, 1);
        }
    };
    const context = vm.createContext({ console, setTimeout, TextDecoder, AbortController, Blob });
    const modules = new Map();
    async function load(name) {
        if (modules.has(name)) return modules.get(name);
        let mod;
        if (name === 'db.js') mod = new vm.SyntheticModule(Object.keys(db), function () {
            for (const [key, value] of Object.entries(db)) this.setExport(key, value);
        }, { context });
        else mod = new vm.SourceTextModule(fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8'), { context });
        modules.set(name, mod);
        await mod.link(specifier => load(path.basename(specifier)));
        await mod.evaluate();
        return mod;
    }
    const reader = (await load('import-json.js')).namespace;
    const importer = (await load('import-data.js')).namespace;
    const plain = value => JSON.parse(JSON.stringify(value));
    const doc = { type: 'user', outfits: [{ id: 'x', name: '冬日👗', description: '换行\n引号"反斜线\\', imageData: 'data:image/jpeg;base64,YQ==' }], nested: [true, false, null, -12.3e5, { a: [] }] };
    for (const chunkSize of [1, 2, 3, 7, 31, 256 * 1024]) {
        assert.deepEqual(plain(await reader.readImportJson(new Blob(['\uFEFF' + JSON.stringify(doc)]), { chunkSize })), doc);
    }
    const rawProto = '{"__proto__":{"polluted":true},"outfits":[]}';
    const parsedProto = await reader.readImportJson(new Blob([rawProto]), { chunkSize: 5 });
    assert.ok(Object.hasOwn(parsedProto, '__proto__'));
    assert.equal(parsedProto.polluted, undefined);
    for (const bad of ['', '{', '{"a":1,}', '[1,]', '{"a" 1}', '{"a":01}', '{}{}', '{"x":"bad\nstring"}', '{"a":tru}', '{"a":"\\q"}', '{"a":1}\u00a0']) {
        await assert.rejects(reader.readImportJson(new Blob([bad]), { chunkSize: 3 }), /JSON/);
    }
    await assert.rejects(reader.readImportJson(new Blob(['{"a":"long token"}']), { maxTokenLength: 5 }), /安全/);
    await assert.rejects(reader.readImportJson(new Blob(['{"a":"12345","b":"67890"}']), { maxRetainedLength: 8 }), /总量/);
    const abortRead = new AbortController();
    await assert.rejects(reader.readImportJson(new Blob([JSON.stringify(doc)]), {
        chunkSize: 5, signal: abortRead.signal, onProgress: () => abortRead.abort()
    }), { name: 'AbortError' });
    let images = 0, maxRead = 0;
    const imageDoc = { outfits: [doc.outfits[0]], _assets: { a: 'data:image/png;base64,Yg==' } };
    const imageBlob = new Blob([JSON.stringify(imageDoc)]);
    const chunkOnlyFile = { size: imageBlob.size, slice: (a, b) => { maxRead = Math.max(maxRead, b - a); return imageBlob.slice(a, b); }, text: () => { throw Error('whole-file read forbidden'); } };
    const reduced = await reader.readImportJson(chunkOnlyFile, { chunkSize: 8, transformImage: async () => { images++; return 'small'; } });
    assert.equal(images, 2); assert.equal(reduced._assets.a, 'small'); assert.ok(maxRead <= 8);

    const existing = {
        outfits: [{ id: 'keep', name: '冬日', description: 'old' }],
        accessories: [{ id: 'acc', name: '帽子', category: '帽子' }],
        categories: ['原分类'], accCategories: ['帽子'], activeIds: ['keep']
    };
    const source = {
        outfits: [{ id: 'source', name: '冬日', description: 'new', kits: [{ id: 'kit', accIds: ['acc'], disabledAccIds: ['acc'] }], activeKitId: 'kit' }],
        accessories: [{ id: 'acc', name: '围巾', category: '饰品' }], categories: ['新分类'], accCategories: ['饰品']
    };
    for (const mode of ['merge', 'update', 'replace']) {
        const before = JSON.stringify(existing);
        const merged = await importer.mergeImportPartition(existing, source, mode);
        assert.equal(JSON.stringify(existing), before, 'uncommitted changes must not mutate the cached wardrobe');
        const outfit = merged.outfits.at(-1), accessory = merged.accessories.at(-1);
        assert.equal(outfit.kits[0].accIds[0], accessory.id);
        assert.equal(outfit.kits[0].disabledAccIds[0], accessory.id);
        assert.equal(merged.outfits.length, mode === 'merge' ? 2 : 1);
        assert.equal(merged.activeIds.length, mode === 'replace' ? 0 : 1);
        if (mode === 'update') assert.equal(outfit.id, 'keep');
    }
    const preset = await importer.mergeImportPartition({}, { ...source, activeIds: ['source'] }, 'replace', { preserveActive: true });
    assert.equal(preset.activeIds[0], preset.outfits[0].id);
    const batchTicks = [];
    await importer.mergeImportPartition({}, { outfits: Array.from({ length: 45 }, (_, i) => ({ name: '' + i })) }, 'replace', { onProgress: done => batchTicks.push(done) });
    assert.deepEqual(batchTicks, [20, 40, 45]);
    const controller = new AbortController();
    await assert.rejects(importer.mergeImportPartition(existing, { outfits: Array.from({ length: 45 }, (_, i) => ({ name: '' + i })) }, 'merge', {
        signal: controller.signal, onProgress: () => controller.abort()
    }), { name: 'AbortError' });

    parts['user:chosen-preset'] = existing;
    await importer.importWardrobes({ type: 'user', ...source }, 'merge');
    assert.deepEqual(saves, ['user:chosen-preset']);
    const savedCount = saves.length;
    await assert.rejects(importer.importWardrobes({ outfits: [], chars: { Bad: { outfits: 'invalid' } } }, 'replace'));
    assert.equal(saves.length, savedCount, 'validate the entire file before any write');
    failSave = true;
    const original = JSON.stringify(parts);
    await assert.rejects(importer.importWardrobes({ type: 'user', ...source }, 'replace'), /quota/);
    assert.equal(JSON.stringify(parts), original);
    failSave = false;
    await importer.importWardrobes({ type: 'chars_all', chars: { Alice: source, __shared__: source } }, 'merge');
    assert.ok(meta.charIndex.some(e => e.name === 'Alice'));
    assert.ok(parts['char:__shared__']);
    await importer.importWardrobes({ type: 'preset', preset: { ...source, name: '测试预设', activeIds: ['source'] } }, 'merge');
    assert.equal(meta.presets.length, 1);
    const importedPreset = parts[meta.presets[0].partKey];
    assert.equal(importedPreset.activeIds[0], importedPreset.outfits[0].id);

    server = true;
    const assets = { same: 'data:image/jpeg;base64,YQ==' };
    await importer.importWardrobes({ type: 'user', outfits: [{ name: 'A', imageData: prefix + 'same' }, { name: 'B', imageData: prefix + 'same' }, { name: 'C', imageData: 'data:image/jpeg;base64,Yg==' }], _assets: assets }, 'merge');
    assert.equal(uploads, 2, 'shared assets upload once'); assert.equal(maximum, 1, 'uploads are sequential');
    failUpload = true;
    const beforeFailure = saves.length;
    await assert.rejects(importer.importWardrobes({ type: 'user', outfits: [doc.outfits[0]] }, 'merge'), /上传失败/);
    assert.equal(saves.length, beforeFailure);
    server = false;
    const stopBetween = new AbortController();
    await assert.rejects(importer.importWardrobes({ type: 'chars_all', chars: { First: source, Second: source } }, 'replace', {
        signal: stopBetween.signal,
        onProgress: p => { if (p.phase === 'saved') stopBetween.abort(); }
    }), error => error.name === 'AbortError' && error.completedWardrobes === 1);
    assert.ok(!meta.charIndex.some(e => e.name === 'Second'));

    // Synthetic large export: no whole-file read, image transformation is awaited
    // before retaining each value, and timers continue to run during parsing.
    const count = Number(process.env.OM_IMPORT_STRESS_MB || 24);
    const record = JSON.stringify({ name: '大图', imageData: 'data:image/jpeg;base64,' + 'A'.repeat(1024 * 1024) });
    const chunks = ['{"outfits":['];
    for (let i = 0; i < count; i++) chunks.push((i ? ',' : '') + record);
    chunks.push(']}');
    const bigFile = new Blob(chunks);
    if (process.env.OM_IMPORT_STRESS_MB) {
        const originalImages = await reader.readImportJson(bigFile);
        assert.equal(originalImages.outfits.length, count);
        assert.equal(originalImages.outfits.at(-1).imageData.length, 1024 * 1024 + 23);
    }
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const result = await reader.readImportJson(bigFile, { transformImage: async () => 'reduced' });
    clearInterval(timer);
    assert.equal(result.outfits.length, count);
    assert.ok(ticks > 1, 'large input must not starve the event loop');
    assert.ok(JSON.stringify(result).length < count * 100);
    console.log('import: pass (JSON boundaries, malformed files, cancellation, memory guards, modes, kit IDs, presets, sequential uploads, write failures, ' + count + ' MiB chunked input)');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
