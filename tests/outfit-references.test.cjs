'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
    let meta;
    let parts;
    const state = { curCat: '__all__', batchSelected: [], resolvedImages: {} };
    const context = vm.createContext({
        console, URL, Date,
        document: { getElementById: () => null },
        SillyTavern: { getContext: () => ({ name2: 'Alice' }) }
    });
    const db = {
        loadMeta: () => meta,
        loadActivePartitions: () => parts,
        currentUserPartKey: () => 'user:default',
        charNameById: () => 'Alice'
    };
    const cache = new Map();
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        let source = fs.readFileSync(path.resolve(__dirname, '..', 'src', name), 'utf8');
        if (name === 'inject.js') source += '\nexport { tryInjectPayload };';
        const mod = new vm.SourceTextModule(source, { context, identifier: name });
        cache.set(name, mod);
        await mod.link(async (specifier, parent) => {
            const child = path.basename(specifier);
            if (['data.js', 'utils.js'].includes(child)) return load(child);
            const match = fs.readFileSync(path.resolve(__dirname, '..', 'src', parent.identifier), 'utf8')
                .match(new RegExp('import\\s*\\{([^}]+)\\}\\s*from [\'\"]' + specifier.replaceAll('.', '\\.') + '[\'\"]'));
            const names = match[1].split(',').map(n => n.trim());
            return new vm.SyntheticModule(names, function () {
                for (const key of names) this.setExport(key,
                    child === 'bridge.js' ? (key === 'state' ? state : {}) : (db[key] || (() => {})));
            }, { context });
        });
        await mod.evaluate();
        return mod;
    }
    const inject = (await load('inject.js')).namespace.tryInjectPayload;
    const data = (await load('data.js')).namespace;
    const renderGrid = (await load('ui-outfits.js')).namespace.renderOutfitGrid;
    const part = {
        outfits: [
            { id: 'a', name: '居家穿搭', description: '棉质睡衣', category: '居家' },
            { id: 'b', name: '冬日奶白系穿搭', description: '奶油白毛呢大衣', imageData: 'image-b', category: '秋冬', favorite: true },
            { id: 'c', name: '雨天穿搭', description: '防水外套', imageData: 'image-c', category: '外出' },
            { id: 'd', name: '未选穿搭', imageData: 'image-d' }
        ],
        activeIds: ['c', 'a', 'b']
    };
    function request() {
        const p = { messages: [{ role: 'user', content: '我想穿冬日奶白系穿搭' }] };
        assert.equal(inject(p), true);
        return p;
    }
    function textOf(p) {
        return p.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text)).join('\n');
    }
    function assertImages(p) {
        const blocks = p.messages.at(-1).content;
        for (const [url, label] of [['image-b', '[穿搭2] 名称：冬日奶白系穿搭'], ['image-c', '[穿搭3] 名称：雨天穿搭']]) {
            const i = blocks.findIndex(b => b.image_url?.url === url);
            assert.ok(i > 0);
            assert.ok(blocks[i - 1].text.includes(label), 'image must keep its wardrobe number despite missing images / reversed selection');
        }
    }
    parts = { 'user:default': part };
    for (const mode of ['text', 'image', 'both']) {
        for (const injectPosition of ['user', 'system', 'context']) {
            meta = { ...data.defMeta(), mode, injectPosition };
            const p = request();
            const text = textOf(p);
            assert.ok(text.includes('[穿搭2] 名称：冬日奶白系穿搭'));
            assert.ok(text.includes('[穿搭3] 名称：雨天穿搭'));
            assert.ok(text.includes('用户明确指定穿搭名称或编号'));
            assert.ok(!text.includes('未选穿搭'));
            if (mode !== 'text') assertImages(p);
            if (mode !== 'image') assert.ok(text.includes('奶油白毛呢大衣'));
            assert.equal(inject(p), false, 'do not inject twice');
        }
    }
    // Existing custom templates receive labels and selection guidance without resetting settings.
    meta = { ...data.defMeta(), multiTemplate: '自定义\n{{wardrobe}}' };
    assert.ok(textOf(request()).includes('自定义\n[穿搭3]'));
    part.activeIds = ['b'];
    assert.ok(textOf(request()).includes('[穿搭2] 名称：冬日奶白系穿搭'));
    part.activeIds = ['d'];
    assert.ok(textOf(request()).includes('[穿搭4] 名称：未选穿搭'), 'name-only outfits still have identity');
    // Character and shared wardrobes use their own number mapping.
    part.activeIds = ['c', 'b'];
    for (const key of ['char:alice', 'char:' + data.SHARED_CHAR_KEY]) {
        parts = { [key]: part };
        assert.ok(textOf(request()).includes('[Alice的可选穿搭]'));
        assert.ok(textOf(request()).includes('[穿搭2] 名称：冬日奶白系穿搭'));
    }
    // Render actual grid markup: favorite moves b first, filters leave its number at 2.
    const area = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
    renderGrid(area, part);
    assert.ok(area.innerHTML.indexOf('data-id="b"') < area.innerHTML.indexOf('data-id="a"'));
    assert.match(area.innerHTML, /data-id="b"[\s\S]*?om-card-number[^>]*>穿搭2<\/span>/);
    state.curCat = '秋冬';
    state.searchQuery = '奶白';
    part.activeIds = [];
    renderGrid(area, part);
    assert.ok(!area.innerHTML.includes('data-id="a"'));
    assert.match(area.innerHTML, /om-card-number[^>]*>穿搭2<\/span>/);
    console.log('outfit references: pass (names, numbers, modes, positions, images, owners, templates, grid filtering)');
}

run().catch(err => { console.error(err); process.exitCode = 1; });
