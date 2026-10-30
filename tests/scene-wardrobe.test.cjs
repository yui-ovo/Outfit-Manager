'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
    let tool, failSave = false, saves = 0, userKey = 'user:default', supported = true;
    let ctx = { characterId: 0, name2: 'Alice', chatMetadata: {}, chat: [{ is_user: true, mes: '去夜店前换衣服' }],
        saveMetadata: async () => { if (failSave) throw Error('offline'); saves++; },
        isToolCallingSupported: () => supported,
        registerFunctionTool: definition => { tool = definition; } };
    const originalContext = ctx;
    const part = {
        outfits: [
            { id: 'a', name: '黑裙', category: '夜店', description: '黑色丝绒裙' },
            { id: 'b', name: '红裙', category: '夜店', description: '红色缎面裙' },
            { id: 'c', name: '风衣', category: '外出', description: '永远不应全量发送的风衣描述' }
        ], activeIds: ['c'], accessories: []
    };
    const parts = { [userKey]: part, 'char:alice': { ...part }, 'char:__shared__': { ...part } };
    let meta;
    const db = {
        loadMeta: () => meta, loadPartition: key => parts[key], currentUserPartKey: () => userKey,
        currentPartKey: () => userKey, charNameById: () => 'Alice',
        loadActivePartitions: () => Object.fromEntries(Object.entries(parts).filter(([k, p]) => p.activeIds.length && k.startsWith('user:'))),
        savePartition: () => {}, syncActivePartitions: () => {}
    };
    const timers = new Map(); let timerId = 0;
    const context = vm.createContext({ console, URL, Date, SillyTavern: { getContext: () => ctx },
        setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id) });
    const cache = new Map();
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        if (name === 'db.js') mod = new vm.SyntheticModule(Object.keys(db), function () {
            for (const [k, v] of Object.entries(db)) this.setExport(k, v);
        }, { context });
        else {
            let source = fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
            if (name === 'inject.js') source += '\nexport { tryInjectPayload };';
            mod = new vm.SourceTextModule(source, { context });
        }
        cache.set(name, mod);
        await mod.link(spec => load(path.basename(spec)));
        await mod.evaluate(); return mod;
    }
    const data = (await load('data.js')).namespace;
    meta = { ...data.defMeta(), charIndex: [{ id: 'alice', name: 'Alice', partKey: 'char:alice' }] };
    const scene = (await load('scene-wardrobe.js')).namespace;
    const inject = (await load('inject.js')).namespace.tryInjectPayload;
    scene.registerSceneTools();
    assert.equal(scene.sceneSupported(), true);
    assert.equal(tool.stealth, false, 'the model must receive the draw before continuing');
    assert.equal(tool.shouldRegister(), false);
    await scene.configureScene(userKey, { category: '夜店', subCategory: '' });
    assert.equal(tool.shouldRegister(), true);
    assert.equal(scene.sceneEntry(userKey).current.id, 'c', 'adding a pool does not change clothes');
    const before = saves;
    scene.scenePrompt(); scene.scenePrompt();
    assert.equal(saves, before, 'reading/injecting alone never rolls or changes state');
    const result = await tool.action({ owner: userKey, category: '夜店' });
    assert.match(result, /黑裙|红裙/);
    const selected = scene.sceneEntry(userKey).current.id;
    assert.ok(['a', 'b'].includes(selected));
    await tool.action({ owner: userKey, category: '夜店' });
    assert.equal(scene.sceneEntry(userKey).current.id, selected, 'same-turn retries are idempotent');
    assert.deepEqual(part.activeIds, ['c'], 'scene mode preserves the manual selections for exit');
    for (const mode of ['text', 'image', 'both']) {
        meta.mode = mode;
        const payload = { messages: [{ role: 'user', content: '在夜店聊天' }] };
        assert.equal(inject(payload), true);
        const text = JSON.stringify(payload);
        assert.ok(!text.includes('永远不应全量发送的风衣描述'));
        assert.ok(text.includes(selected === 'a' ? '黑色丝绒裙' : '红色缎面裙'));
        assert.ok(!text.includes(selected === 'a' ? '红色缎面裙' : '黑色丝绒裙'));
        assert.equal(inject(payload), false);
    }
    ctx.chat.push({ is_user: true, mes: '回家洗完澡换睡衣' });
    await tool.action({ owner: userKey, category: '睡衣', fallback_description: '宽松棉质睡衣' });
    assert.equal(scene.sceneEntry(userKey).current.type, 'temporary');
    assert.equal(part.outfits.length, 3);
    const payload = { messages: [{ role: 'user', content: '躺下睡觉' }] };
    inject(payload);
    assert.match(JSON.stringify(payload), /宽松棉质睡衣/);
    assert.ok(!JSON.stringify(payload).includes('风衣描述'));
    assert.ok(!JSON.stringify(payload).includes('红色缎面裙'));
    ctx.chat.push({ is_user: true, mes: '穿搭3' });
    await tool.action({ owner: userKey, category: '', selector: '穿搭3' });
    assert.equal(scene.sceneEntry(userKey).current.id, 'c', 'explicit choice can address items outside random pools');
    ctx.chat.push({ is_user: true, mes: '再换' });
    assert.match(await tool.action({ owner: userKey, category: '外出', fallback_description: '另编衣服' }), /未加入/);
    assert.equal(scene.sceneEntry(userKey).current.id, 'c');
    failSave = true;
    assert.match(await tool.action({ owner: userKey, category: '夜店' }), /保存失败/);
    assert.equal(scene.sceneEntry(userKey).current.id, 'c');
    failSave = false;
    await scene.changeSceneOutfit({ owner: userKey, category: '夜店' }, true);
    const first = scene.sceneEntry(userKey).current.id;
    await scene.changeSceneOutfit({ owner: userKey, category: '夜店' }, true);
    assert.notEqual(scene.sceneEntry(userKey).current.id, first, 'manual reroll avoids the current outfit where possible');
    ctx = { ...originalContext, chatMetadata: {} };
    assert.equal(scene.sceneOwners().length, 0, 'a different chat has no inherited clothing state');
    assert.equal(tool.shouldRegister(), false);
    ctx = originalContext;
    assert.ok(scene.sceneEntry(userKey).current);
    userKey = 'user:different';
    assert.equal(scene.sceneOwners().length, 0, 'another user preset does not reuse the former one');
    userKey = 'user:default';
    await scene.configureScene('char:alice', { category: '夜店' });
    await scene.configureScene('char:__shared__', { category: '夜店' });
    assert.ok(!scene.sceneOwners().some(o => o.key === 'char:alice'), 'shared wardrobe wins');
    supported = false;
    assert.match(scene.scenePrompt(), /未启用自动换装工具/);
    await scene.configureScene(userKey, null, false);
    assert.equal(scene.sceneEntry(userKey).enabled, false);

    const old = { singleTemplate: '[User当前穿着]\n{{description}}\n（禁止编造其他服装。严禁集中罗列服装信息，服装细节必须分散融入不同的动作、触感、环境互动中，每次只带出一两个细节。）', multiTemplate: '自己的模板' };
    assert.equal(data.upgradeOutfitTemplates(old), true);
    assert.match(old.singleTemplate, /普通日常服装/);
    assert.equal(old.multiTemplate, '自己的模板');

    // Long press opens the menu; swiping a category strip cancels the timer.
    const bridge = (await load('bridge.js')).namespace;
    let menus = 0;
    bridge.fn.createSheet = () => { menus++; return { querySelectorAll: () => [] }; };
    bridge.state.curCat = '__all__';
    class Button {
        constructor() { this.dataset = { c: '夜店' }; this.handlers = {}; }
        addEventListener(name, cb) { (this.handlers[name] ||= []).push(cb); }
        fire(name, e = {}) { (this.handlers[name] || []).forEach(cb => cb(e)); }
    }
    context.document = { createElement: () => new Button() };
    const ui = (await load('ui-scene.js')).namespace;
    const button = new Button();
    ui.bindSceneCategories({ querySelectorAll: () => [button], appendChild: () => {} });
    button.fire('pointerdown', { button: 0, clientX: 0, clientY: 0 });
    button.fire('pointermove', { clientX: 20, clientY: 0 });
    assert.equal(timers.size, 0);
    button.fire('pointerdown', { button: 0, clientX: 0, clientY: 0 });
    [...timers.values()].forEach(cb => cb()); timers.clear();
    assert.equal(menus, 1);
    let prevented = false;
    button.fire('click', { preventDefault: () => { prevented = true; }, stopImmediatePropagation() {} });
    assert.equal(prevented, true);
    console.log('scene wardrobe: pass (pool/explicit/fallback selection, retries, chat/preset isolation, persistence failures, text-only injection, migration, long press/scroll)');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
