'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('secondary selector: state, API boundaries, failures, async main transport and UI', async () => {
    let failSave = false, saves = 0, userKey = 'user:default', requests = [];
    const events = new Map();
    let ctx = { characterId: 0, name2: 'Alice', chatMetadata: {}, chat: [{ is_user: true, mes: '去夜店前换衣服' }],
        saveMetadata: async () => { if (failSave) throw Error('offline'); saves++; },
        eventSource: { on: (name, fn) => events.set(name, fn) },
        event_types: { CHAT_COMPLETION_SETTINGS_READY: 'ready', GENERATION_STOPPED: 'stop' } };
    const originalContext = ctx;
    const part = { outfits: [
        { id: 'a', name: '黑裙', category: '夜店', description: '黑色丝绒裙', imageData: 'secret-image-a' },
        { id: 'b', name: '红裙', category: '夜店', description: '红色缎面裙' },
        { id: 'c', name: '风衣', category: '外出', description: '永远不应全量发送的风衣描述' }
    ], activeIds: ['c'], accessories: [] };
    const parts = { [userKey]: part, 'char:alice': { ...part }, 'char:__shared__': { ...part } };
    let meta, responder = () => ({ decisions: [{ owner: userKey, action: 'keep' }] });
    const db = { loadMeta: () => meta, saveMeta: value => { meta = value; }, loadPartition: key => parts[key], currentUserPartKey: () => userKey,
        currentPartKey: () => userKey, charNameById: () => 'Alice', savePartition() {}, syncActivePartitions() {},
        loadActivePartitions: () => Object.fromEntries(Object.entries(parts).filter(([k, p]) => p.activeIds.length && k.startsWith('user:'))) };
    const timers = new Map(); let timerId = 0;
    const nativeFetch = async (url, init) => {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : url instanceof Request ? await url.clone().json() : {};
        requests.push({ url: String(url instanceof Request ? url.url : url), init, body });
        if (init?.__omInternal) {
            const answer = await responder(body);
            return { ok: answer?.http ? false : true, status: answer?.http || 200,
                json: async () => ({ choices: [{ message: { content: answer?.raw ?? JSON.stringify(answer) } }] }) };
        }
        return { ok: true, body };
    };
    class XHR {
        open(method, url) { this.readyState = 1; this.url = url; }
        setRequestHeader() {}
        send(body) { this.sent = body; }
        abort() { this.readyState = 0; }
    }
    const context = vm.createContext({ console, URL, Date, Headers, Request, AbortController, DOMException,
        SillyTavern: { getContext: () => ctx }, location: { href: 'https://tavern.test/', origin: 'https://tavern.test' },
        window: { fetch: nativeFetch }, XMLHttpRequest: XHR,
        setTimeout: cb => { timers.set(++timerId, cb); return timerId; }, clearTimeout: id => timers.delete(id) });
    context.fetch = (...args) => context.window.fetch(...args);
    const cache = new Map();
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        let mod;
        const stub = name === 'db.js' ? db : name === 'api.js' ? { openModelPicker() {} } : null;
        if (stub) mod = new vm.SyntheticModule(Object.keys(stub), function () { for (const [k, v] of Object.entries(stub)) this.setExport(k, v); }, { context });
        else {
            let source = fs.readFileSync(path.resolve(__dirname, '../src', name), 'utf8');
            if (name === 'inject.js') source += '\nexport { tryInjectPayload };';
            mod = new vm.SourceTextModule(source, { context });
        }
        cache.set(name, mod); await mod.link(spec => load(path.basename(spec))); await mod.evaluate(); return mod;
    }
    const data = (await load('data.js')).namespace;
    meta = { ...data.defMeta(), charIndex: [{ id: 'alice', name: 'Alice', partKey: 'char:alice' }] };
    const scene = (await load('scene-wardrobe.js')).namespace;
    const api = (await load('scene-api.js')).namespace;
    const injection = (await load('inject.js')).namespace;
    assert.equal(scene.sceneSupported(), false);
    meta.apiScene = { enabled: true, endpoint: 'https://secondary.test/v1', key: 'private-key', model: 'text-model', timeoutSeconds: 20 };
    assert.equal(scene.sceneSupported(), true, 'no tool calling capability needed');
    assert.equal(api.sceneApiEndpoint('https://x.test/v1/chat/completions'), 'https://x.test/v1/chat/completions');
    assert.equal(api.sceneApiEndpoint('https://x.test/api/v2/'), 'https://x.test/api/v2/chat/completions');
    assert.throws(() => api.sceneApiEndpoint('file:///secret'), /格式/);
    assert.equal(api.sceneApiConfig({ apiScene: { reuseVision: true }, apiVision: { model: 'reuse' } }).model, 'reuse');
    await scene.configureScene(userKey, { category: '夜店', subCategory: '' });
    assert.equal(scene.sceneEntry(userKey).current.id, 'c');
    const before = saves;
    scene.scenePrompt(); scene.scenePrompt();
    assert.equal(saves, before, 'reading alone never changes clothes');
    responder = body => body.messages[0].content.includes('decisions')
        ? { decisions: [{ owner: userKey, action: 'change', category_id: 'c1', requirements: '去夜店' }] }
        : { ids: ['a', 'b'] };
    await Promise.all([scene.prepareSceneOutfits(), scene.prepareSceneOutfits()]);
    assert.equal(requests.length, 2, 'one judgement plus one shortlist request, coalesced across concurrent main hooks');
    let selected = scene.sceneEntry(userKey).current.id;
    assert.ok(['a', 'b'].includes(selected));
    const judgeData = JSON.parse(requests[0].body.messages[1].content);
    assert.equal(judgeData.wardrobes[0].categories[0].count, 2);
    assert.ok(!JSON.stringify(judgeData).includes('黑色丝绒裙'), 'first phase sends catalogue, not wardrobe descriptions');
    assert.ok(!JSON.stringify(requests.map(r => r.body)).includes('secret-image'));
    await scene.prepareSceneOutfits();
    assert.equal(requests.length, 2, 'same input reuses saved decision');
    assert.deepEqual(part.activeIds, ['c']);
    for (const mode of ['text', 'image', 'both']) {
        meta.mode = mode;
        const payload = { messages: [{ role: 'user', content: '在夜店聊天' }] };
        assert.equal(injection.tryInjectPayload(payload), true);
        const text = JSON.stringify(payload);
        assert.ok(text.includes(selected === 'a' ? '黑色丝绒裙' : '红色缎面裙'));
        assert.ok(!text.includes(selected === 'a' ? '红色缎面裙' : '黑色丝绒裙'));
        assert.ok(!/永远不应全量发送|secret-image|private-key|category_id|outfit_manager_change|候选目录/.test(text));
        assert.equal(injection.tryInjectPayload(payload), false);
    }
    function next(text) { ctx.chat.push({ is_user: true, mes: text }); }
    next('回家洗完澡换睡衣');
    responder = () => ({ decisions: [{ owner: userKey, action: 'change', category_id: '', description: '宽松棉质睡衣' }] });
    await scene.prepareSceneOutfits();
    assert.equal(scene.sceneEntry(userKey).current.type, 'temporary');
    assert.equal(part.outfits.length, 3);
    assert.match(scene.scenePrompt(), /宽松棉质睡衣/);
    next('明天再去夜店，今天不换');
    responder = () => ({ decisions: [{ owner: userKey, action: 'keep' }] });
    await scene.prepareSceneOutfits();
    assert.match(scene.scenePrompt(), /宽松棉质睡衣/);
    next('穿搭3');
    responder = () => ({ decisions: [{ owner: userKey, action: 'change', selector: '穿搭3' }] });
    await scene.prepareSceneOutfits();
    assert.equal(scene.sceneEntry(userKey).current.id, 'c', 'explicit selector can address full wardrobe');
    next('冬日风衣');
    responder = () => ({ decisions: [{ owner: userKey, action: 'change', selector: '不存在的名字' }] });
    await scene.prepareSceneOutfits();
    assert.equal(scene.sceneEntry(userKey).current.id, 'c');
    assert.match(scene.sceneStatus(), /不唯一/);
    for (const bad of [{ raw: 'not json' }, { http: 503 }, { decisions: [{ owner: 'wrong-owner', action: 'change' }] }]) {
        next('失败回退' + JSON.stringify(bad)); responder = () => bad;
        await scene.prepareSceneOutfits();
        assert.equal(scene.sceneEntry(userKey).current.id, 'c');
        assert.match(scene.sceneStatus(), /沿用当前穿着/);
    }
    next('保存失败'); failSave = true;
    responder = () => ({ decisions: [{ owner: userKey, action: 'change', selector: '黑裙' }] });
    await scene.prepareSceneOutfits(); failSave = false;
    assert.equal(scene.sceneEntry(userKey).current.id, 'c');
    await scene.changeSceneOutfit({ owner: userKey, pool: { category: '夜店' } });
    const first = scene.sceneEntry(userKey).current.id;
    await scene.changeSceneOutfit({ owner: userKey, pool: { category: '夜店' } });
    assert.notEqual(scene.sceneEntry(userKey).current.id, first);
    const callsBeforeManual = requests.length;
    await scene.prepareSceneOutfits();
    assert.equal(requests.length, callsBeforeManual, 'manual choice wins until conversation changes');

    next('接口超时');
    let release;
    responder = () => new Promise(resolve => { release = resolve; });
    const waiting = scene.prepareSceneOutfits();
    assert.equal(timers.size, 1);
    [...timers.values()][0]();
    await waiting;
    const currentBeforeLate = JSON.stringify(scene.sceneEntry(userKey).current);
    release({ decisions: [{ owner: userKey, action: 'change', selector: '穿搭3' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(JSON.stringify(scene.sceneEntry(userKey).current), currentBeforeLate, 'late result cannot overwrite fallback after timeout');

    next('切换聊天');
    const switching = scene.prepareSceneOutfits();
    ctx = { ...originalContext, chatMetadata: {} };
    release({ decisions: [{ owner: userKey, action: 'change', selector: '穿搭3' }] });
    await switching;
    assert.equal(scene.sceneOwners().length, 0);
    ctx = originalContext;
    assert.equal(JSON.stringify(scene.sceneEntry(userKey).current), currentBeforeLate);
    userKey = 'user:different'; assert.equal(scene.sceneOwners().length, 0); userKey = 'user:default';

    // Exercise real wrappers: side request resolves before any main bytes leave.
    injection.setupInjection();
    next('fetch换上风衣');
    responder = () => new Promise(resolve => { release = resolve; });
    const mainCount = () => requests.filter(r => !r.init?.__omInternal).length;
    let prior = mainCount();
    let pending = context.window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'fetch换上风衣' }] }) });
    assert.equal(mainCount(), prior);
    release({ decisions: [{ owner: userKey, action: 'change', selector: '穿搭3' }] });
    let sent = await pending;
    assert.equal(mainCount(), prior + 1);
    assert.match(JSON.stringify(sent.body), /风衣描述/);
    assert.ok(!JSON.stringify(sent.body).includes('黑色丝绒裙'));
    next('event换黑裙');
    responder = () => ({ decisions: [{ owner: userKey, action: 'change', selector: '黑裙' }] });
    const eventPayload = { type: 'normal', messages: [{ role: 'user', content: 'event换黑裙' }] };
    prior = requests.length;
    await events.get('ready')(eventPayload);
    sent = await context.window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify(eventPayload) });
    assert.equal(requests.length, prior + 2, 'event then fetch makes only one secondary request');
    assert.equal(JSON.stringify(sent.body).match(/当前穿着参考/g).length, 1);
    const quiet = { type: 'quiet', messages: [{ role: 'user', content: '总结' }] };
    prior = requests.length; await events.get('ready')(quiet);
    assert.equal(requests.length, prior); assert.ok(!JSON.stringify(quiet).includes('穿着参考'));
    await context.window.fetch('https://secondary.test/v1/chat/completions', { __omInternal: true, method: 'POST', body: JSON.stringify({ model: 'x', messages: [] }) });
    assert.ok(!JSON.stringify(requests.at(-1).body).includes('穿着参考'), 'internal request skips injection');

    next('Request对象换衣服');
    responder = () => ({ decisions: [{ owner: userKey, action: 'keep' }] });
    sent = await context.window.fetch(new Request('https://tavern.test/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '继续' }] }) }));
    assert.match(JSON.stringify(sent.body), /当前穿着参考/);
    next('百宝库换衣服');
    sent = await context.window.fetch('/api/plugins/baibaoku/v1/chats/save-generate', { method: 'POST', body: JSON.stringify({ chat: 'unchanged', generate: { messages: [{ role: 'user', content: '继续' }] } }) });
    assert.equal(sent.body.chat, 'unchanged'); assert.match(JSON.stringify(sent.body.generate), /当前穿着参考/);
    next('XHR换衣服');
    responder = () => new Promise(resolve => { release = resolve; });
    const xhr = new XHR(); xhr.open('POST', '/api/backends/chat-completions/generate', true);
    xhr.send(JSON.stringify({ messages: [{ role: 'user', content: '继续' }] }));
    assert.equal(xhr.sent, undefined);
    release({ decisions: [{ owner: userKey, action: 'change', selector: '红裙' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.match(xhr.sent, /红色缎面裙/);
    next('XHR取消');
    const cancelled = new XHR(); cancelled.open('POST', '/api/backends/chat-completions/generate', true);
    cancelled.send(JSON.stringify({ messages: [{ role: 'user', content: '继续' }] })); cancelled.abort();
    release({ decisions: [{ owner: userKey, action: 'change', selector: '穿搭3' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled.sent, undefined);
    assert.equal(scene.sceneEntry(userKey).current.id, 'b');
    next('停止生成');
    prior = mainCount();
    pending = context.window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: '继续' }] }) });
    events.get('stop')();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(mainCount(), prior);
    release({ decisions: [{ owner: userKey, action: 'change', selector: '穿搭3' }] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(scene.sceneEntry(userKey).current.id, 'b');

    // Large category: shortlist is bounded and credentials never enter model content.
    for (let i = 0; i < 100; i++) part.outfits.push({ id: 'more' + i, category: '夜店', name: '其他' + i, description: '细节'.repeat(500) });
    next('大分类再抽一套');
    responder = body => {
        const input = JSON.parse(body.messages[1].content);
        if (input.wardrobes) return { decisions: [{ owner: userKey, action: 'change', category_id: 'c1' }] };
        assert.equal(input.candidates.length, 24);
        assert.ok(input.candidates.every(o => o.description.length <= 350));
        assert.ok(!JSON.stringify(input).includes('private-key'));
        return { ids: [input.candidates[0].id] };
    };
    await scene.prepareSceneOutfits();
    await scene.configureScene('char:alice', { category: '夜店' });
    await scene.configureScene('char:__shared__', { category: '夜店' });
    assert.ok(!scene.sceneOwners().some(o => o.key === 'char:alice'));
    await scene.configureScene(userKey, null, false);
    assert.equal(scene.sceneEntry(userKey).enabled, false);
    const old = { singleTemplate: '[User当前穿着]\n{{description}}\n（禁止编造其他服装。严禁集中罗列服装信息，服装细节必须分散融入不同的动作、触感、环境互动中，每次只带出一两个细节。）', multiTemplate: '自己的模板' };
    assert.equal(data.upgradeOutfitTemplates(old), true); assert.equal(old.multiTemplate, '自己的模板');

    const bridge = (await load('bridge.js')).namespace;
    let menus = 0;
    bridge.fn.createSheet = () => { menus++; return { querySelectorAll: () => [] }; };
    bridge.state.curCat = '__all__';
    class Button {
        constructor() { this.dataset = { c: '夜店' }; this.handlers = {}; }
        addEventListener(name, cb) { (this.handlers[name] ||= []).push(cb); }
        fire(name, e = {}) { (this.handlers[name] || []).forEach(cb => cb.call(this, e)); }
    }
    context.document = { createElement: () => new Button() };
    const ui = (await load('ui-scene.js')).namespace;
    const button = new Button();
    ui.bindSceneCategories({ querySelectorAll: () => [button], appendChild: () => {} });
    button.fire('pointerdown', { button: 0, clientX: 0, clientY: 0 });
    button.fire('pointermove', { clientX: 20, clientY: 0 }); assert.equal(timers.size, 0);
    button.fire('pointerdown', { button: 0, clientX: 0, clientY: 0 });
    [...timers.values()].forEach(cb => cb()); timers.clear(); assert.equal(menus, 1);
    let prevented = false;
    button.fire('click', { preventDefault() { prevented = true; }, stopImmediatePropagation() {} }); assert.ok(prevented);
    const settings = (await load('ui-scene-settings.js')).namespace;
    assert.match(settings.sceneSettingsHtml(), /场景换装副 API/);
    const controls = new Map();
    const control = name => { if (!controls.has(name)) controls.set(name, new Button()); return controls.get(name); };
    settings.bindSceneSettings({ querySelector: control });
    control('#om-scene-enabled').checked = false; control('#om-scene-enabled').fire('change'); assert.equal(meta.apiScene.enabled, false);
    control('#om-scene-reuse').checked = true; control('#om-scene-reuse').fire('change'); assert.equal(meta.apiScene.reuseVision, true); assert.equal(control('#om-scene-custom').hidden, true);
});
