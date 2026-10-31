'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('category candidates: no secondary API, fixed offers, reply receipts, regeneration, continuation and failures', async () => {
    let saves = 0, fail = false, requests = 0;
    const handlers = new Map();
    const eventSource = { on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); } };
    const types = { CHAT_COMPLETION_SETTINGS_READY: 'ready', GENERATION_STOPPED: 'stop', MESSAGE_RECEIVED: 'received', GENERATION_ENDED: 'ended', MESSAGE_SWIPED: 'swiped' };
    let ctx = { characterId: 0, name2: 'Alice', chatMetadata: {}, chat: [{ is_user: true, mes: '洗完澡换睡衣' }], eventSource, event_types: types,
        saveMetadata: async () => { if (fail) throw Error('disk'); saves++; } };
    const outfits = [
        { id: 'current', category: '日常', name: '现在的衣服', description: '当前衣服完整描述' },
        ...Array.from({ length: 60 }, (_, i) => ({ id: 'sleep' + i, category: '睡衣', subCategory: i % 2 ? '棉质' : '绸缎', name: '睡衣' + i, description: '睡衣细节' + i + '长描述'.repeat(200), imageData: 'never-send-image' })),
        ...Array.from({ length: 40 }, (_, i) => ({ id: 'club' + i, category: '夜店', name: '夜店装' + i, description: '夜店装细节' + i })),
        { id: 'casual', category: '日常', name: '另一套日常', description: '日常候选描述' },
        { id: 'secret', category: '未加入', name: '未加入的名字', description: '未加入的描述不发送' }
    ];
    const part = { outfits, activeIds: ['current'], accessories: [] }, key = 'user:default';
    let meta;
    const db = { loadMeta: () => meta, saveMeta: value => { meta = value; }, loadPartition: () => part,
        currentUserPartKey: () => key, currentPartKey: () => key, charNameById: () => 'Alice',
        loadActivePartitions: () => ({ [key]: part }) };
    class XHR { open() {} send() {} abort() {} setRequestHeader() {} }
    const sandbox = vm.createContext({ console, URL, Date, Headers, Request, AbortController, DOMException, setTimeout, clearTimeout,
        SillyTavern: { getContext: () => ctx }, location: { origin: 'https://tavern.test', href: 'https://tavern.test/' }, XMLHttpRequest: XHR,
        window: { fetch: async (url, init) => { requests++; assert.ok(!init.__omInternal, 'candidate mode must not contact the secondary API'); return JSON.parse(init.body); } } });
    sandbox.fetch = (...args) => sandbox.window.fetch(...args);
    const cache = new Map();
    async function load(name) {
        if (cache.has(name)) return cache.get(name);
        const mod = name === 'db.js' ? new vm.SyntheticModule(Object.keys(db), function () { Object.entries(db).forEach(([k, v]) => this.setExport(k, v)); }, { context: sandbox }) :
            new vm.SourceTextModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), { context: sandbox });
        cache.set(name, mod); await mod.link(spec => load(path.basename(spec))); await mod.evaluate(); return mod;
    }
    const data = (await load('data.js')).namespace;
    meta = data.defMeta(); meta.apiScene.enabled = true; meta.apiScene.endpoint = 'https://should-not-call.test'; meta.apiScene.model = 'unused';
    const scene = (await load('scene-wardrobe.js')).namespace;
    const candidate = (await load('scene-candidates.js')).namespace;
    const inject = (await load('inject.js')).namespace;
    const entry = () => scene.sceneEntry(key);
    const copy = obj => JSON.parse(JSON.stringify(obj));
    const comment = value => '<!--om-outfit:' + JSON.stringify(value) + '-->';
    const marker = token => comment({ owner: key, candidate: token });
    const state = () => copy(entry().current);
    const send = async (type = 'normal') => sandbox.window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: JSON.stringify({ type, messages: ctx.chat.map(m => ({ role: m.is_user ? 'user' : 'assistant', content: m.mes })) }) });
    const emit = async (event, ...args) => { for (const fn of handlers.get(event) || []) await fn(...args); };
    const next = text => ctx.chat.push({ is_user: true, mes: text });
    inject.setupInjection();
    await scene.configureScene(key, { category: '睡衣' });
    await scene.configureScene(key, { category: '夜店' });
    await scene.configureScene(key, { category: '日常' });
    assert.equal(entry().candidates.length, 3, 'one candidate per top category, not one per item or subcategory');
    assert.equal(entry().current.id, 'current', 'joining categories does not change clothes');
    const offers = JSON.stringify(entry().candidates);
    let sent = await send();
    assert.equal(requests, 1);
    let text = sent.messages.at(-1).content;
    assert.equal((text.match(/；candidate=/g) || []).length, 3);
    assert.match(text, /当前衣服完整描述/);
    assert.ok(!text.includes('未加入的名字'));
    assert.ok(!text.includes('never-send-image'));
    for (const o of outfits.filter(o => o.category === '夜店' && !entry().candidates.some(c => c.id === o.id))) assert.ok(!text.includes('夜店装细节' + o.id.slice(4) + '\n'));
    const before = saves;
    await scene.prepareSceneOutfits();
    assert.equal(saves, before, 'event/fetch retry shares the same ticket');
    assert.equal(JSON.stringify(entry().candidates), offers);
    ctx.chatMetadata = copy(ctx.chatMetadata); // Simulated persisted reload.
    await scene.prepareSceneOutfits();
    assert.equal(JSON.stringify(entry().candidates), offers, 'reload keeps candidate IDs and tokens');
    const sleep = entry().candidates.find(c => c.category === '睡衣');
    ctx.chat.push({ is_user: false, mes: '换上睡衣。\n' + marker(sleep.token), swipe_id: 0, swipes: [] });
    const replyId = ctx.chat.length - 1;
    ctx.chat[replyId].swipes.push(ctx.chat[replyId].mes, '没有换衣，继续聊天。');
    await emit('received', replyId);
    assert.equal(entry().current.id, sleep.id);
    let previousSaves = saves;
    await emit('ended'); await emit('received', replyId);
    assert.equal(saves, previousSaves, 'stream finish and generation end do not apply twice');
    assert.equal(JSON.stringify(entry().candidates), offers, 'accepting an outfit keeps offers stable until manual refresh');
    const raw = ctx.chat[replyId].mes;
    ctx.chat[replyId].mes = ctx.chat[replyId].swipes[1]; ctx.chat[replyId].swipe_id = 1;
    await emit('swiped', replyId);
    assert.equal(entry().current.id, 'current', 'swipe with no clothing change restores pre-reply clothing');
    ctx.chat[replyId].mes = raw; ctx.chat[replyId].swipe_id = 0;
    await emit('swiped', replyId); assert.equal(entry().current.id, sleep.id);
    // Re-generate the same message: same offer ticket, no gratuitous random draw.
    ctx.chat.pop();
    sent = await send('regenerate');
    assert.match(sent.messages.at(-1).content, /当前穿着：\[穿搭1\]/);
    ctx.chat.push({ is_user: false, mes: '继续穿原来的衣服。' });
    await emit('ended'); assert.equal(entry().current.id, 'current');
    ctx.chat.at(-1).mes = raw; await emit('received', replyId);
    assert.equal(entry().current.id, sleep.id);
    // Continue same assistant message: only new markers are applied.
    await send('continue');
    const club = entry().candidates.find(c => c.category === '夜店');
    ctx.chat.at(-1).mes += '\n后来出门前换上裙子。\n' + marker(club.token);
    await emit('ended'); assert.equal(entry().current.id, club.id);
    // New round uses accepted current clothes; old hidden receipts are not sent.
    next('坐下喝水，不换衣服');
    sent = await send();
    assert.ok(!sent.messages.filter(m => m.role === 'assistant').some(m => m.content.includes('om-outfit:')));
    assert.ok(ctx.chat[replyId].mes.includes('om-outfit:'), 'chat retains raw receipt for swipe replay');
    ctx.chat.push({ is_user: false, mes: '坐下喝水。' }); await emit('ended');
    assert.equal(entry().current.id, club.id);
    next('候选不适合，换普通棉睡衣'); await send();
    ctx.chat.push({ is_user: false, mes: '换好睡衣。\n' + comment({ owner: key, temporary: '宽松白色棉睡衣' }) });
    await emit('ended'); assert.deepEqual(state(), { type: 'temporary', description: '宽松白色棉睡衣' });
    assert.equal(part.outfits.length, 103, 'temporary clothes are not added to collection');
    const held = state();
    for (const bad of [marker('invented'), comment({ owner: 'user:wrong', candidate: sleep.token }), '<!--om-outfit:{broken}-->', marker(sleep.token) + '\n' + marker(club.token)]) {
        next('错误标记测试'); await send(); ctx.chat.push({ is_user: false, mes: '正文。\n' + bad });
        await emit('ended'); assert.deepEqual(state(), held);
        assert.match(scene.sceneStatus(), /未改变/);
    }
    next('代码示例不算换衣'); await send();
    ctx.chat.push({ is_user: false, mes: '示例：\n```\n' + marker(sleep.token) + '\n```' });
    await emit('ended'); assert.deepEqual(state(), held);
    next('保存失败测试'); await send();
    ctx.chat.push({ is_user: false, mes: '换衣。\n' + marker(sleep.token) });
    fail = true; await emit('ended'); assert.deepEqual(state(), held);
    fail = false; await emit('ended'); assert.equal(entry().current.id, sleep.id);
    next('手动刷新测试'); await send();
    const stale = entry().candidates.find(c => c.category === '夜店');
    const current = state();
    await scene.refreshSceneCandidates(key);
    assert.notEqual(JSON.stringify(entry().candidates), offers);
    assert.deepEqual(state(), current);
    ctx.chat.push({ is_user: false, mes: '迟到的旧候选。\n' + marker(stale.token) });
    await emit('ended'); assert.deepEqual(state(), current, 'manual refresh invalidates pending selection');
    next('手动修正'); await send();
    await scene.changeSceneOutfit({ owner: key, selector: '穿搭1' });
    ctx.chat.push({ is_user: false, mes: '迟到。\n' + marker(sleep.token) }); await emit('ended');
    assert.equal(entry().current.id, 'current', 'late reply cannot overwrite manual correction');
    const original = ctx;
    next('聊天隔离'); await send();
    ctx = { ...ctx, chatMetadata: {}, chat: [{ is_user: false, mes: marker(sleep.token) }] };
    await emit('ended'); assert.equal(scene.sceneOwners().length, 0);
    ctx = original; assert.equal(entry().current.id, 'current');
    // A deleted candidate can neither be restored by an old marker nor sent again.
    const doomed = entry().candidates.find(c => c.category === '夜店');
    const idx = part.outfits.findIndex(o => o.id === doomed.id); part.outfits.splice(idx, 1);
    await scene.prepareSceneOutfits();
    assert.ok(entry().candidates.every(c => c.id !== doomed.id));
    const disabledCalls = requests;
    meta.apiScene.mode = 'manual'; await scene.prepareSceneOutfits();
    assert.equal(requests, disabledCalls); assert.ok(!scene.scenePrompt().includes('换装候选'));
    assert.equal(candidate.readCandidateMarkers('普通正文').length, 0);
    const normalized = data.ensureMetaDefaults({ apiScene: { enabled: true } });
    assert.equal(normalized.apiScene.mode, 'api', 'existing enabled API users retain their mode');
});
