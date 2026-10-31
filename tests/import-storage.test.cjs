'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function run() {
    let tx, staged, values = new Map(), failPut = false;
    const fakeDb = {
        transaction() {
            staged = new Map(values);
            tx = {
                objectStore: () => ({ put: (value, key) => {
                    if (failPut && key === 'meta') throw new Error('quota');
                    staged.set(key, JSON.parse(JSON.stringify(value)));
                } }),
                abort: () => { if (tx.onabort) tx.onabort(); }
            };
            return tx;
        }
    };
    const context = vm.createContext({ console, setTimeout, clearTimeout });
    const data = new vm.SourceTextModule(fs.readFileSync(path.resolve(__dirname, '../src/data.js'), 'utf8'), { context });
    await data.link(() => { throw Error('Unexpected data import'); });
    await data.evaluate();
    const source = fs.readFileSync(path.resolve(__dirname, '../src/db.js'), 'utf8') + `
        export function testSetup(db, meta, parts, failed) {
            dbInstance = db; metaCache = meta; partCache = parts; serverInitFailed = failed;
        }
        export function testCache() { return { meta: metaCache, parts: partCache }; }
        export { validateMetaPayload };
    `;
    const mod = new vm.SourceTextModule(source, { context });
    await mod.link(() => data);
    await mod.evaluate();
    const api = mod.namespace;
    const meta = { ...data.namespace.defMeta(), charIndex: [{ id: '__shared__', name: '__shared__', partKey: 'char:__shared__' }] };
    meta.apiScene = { enabled: true, reuseVision: false, endpoint: 'https://secondary.test', key: 'test-key', model: 'text', timeoutSeconds: 20 };
    const oldPart = { ...data.namespace.defPartition(), outfits: [{ id: 'old', name: '原穿搭' }], activeIds: ['old'] };
    const newPart = { ...data.namespace.defPartition(), outfits: [{ id: 'new', name: '新穿搭' }] };
    function reset(failed = false) {
        values = new Map([['meta', meta], ['user:__default__', oldPart]]);
        api.testSetup(fakeDb, meta, { 'user:__default__': oldPart }, failed);
    }
    reset();
    assert.deepEqual(JSON.parse(JSON.stringify(api.load().apiScene)), meta.apiScene, 'legacy settings/export retain the secondary API configuration');
    assert.ok(!api.validateMetaPayload(meta));
    assert.match(api.validateMetaPayload({ ...meta, apiScene: { enabled: 'true' } }), /apiScene.enabled/);
    assert.match(api.validateMetaPayload({ ...meta, apiScene: { mode: 'unknown' } }), /apiScene.mode/);
    assert.match(api.validateMetaPayload({ ...meta, apiScene: { timeoutSeconds: 0 } }), /5–60/);
    let settled = false;
    const pending = api.saveImportPartition('user:__default__', newPart).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, 'must wait for the transaction, not the cache write');
    assert.equal(api.loadPartition('user:__default__'), oldPart);
    values = staged; tx.oncomplete();
    await pending;
    assert.equal(api.loadPartition('user:__default__'), newPart);
    assert.equal(values.get('user:__default__').outfits[0].id, 'new');
    assert.deepEqual(values.get('meta').apiScene, meta.apiScene, 'wardrobe imports preserve API configuration');

    reset();
    const aborted = api.saveImportPartition('user:__default__', newPart);
    tx.onabort();
    await assert.rejects(aborted, /保存失败/);
    assert.equal(api.loadPartition('user:__default__'), oldPart);
    assert.equal(values.get('user:__default__'), oldPart);

    reset(); failPut = true;
    await assert.rejects(api.saveImportPartition('char:new', newPart, { kind: 'char', entry: { id: 'new', name: 'Alice', partKey: 'char:new' } }), /保存失败/);
    assert.ok(!api.loadMeta().charIndex.some(e => e.id === 'new'));
    assert.ok(!values.has('char:new'));
    failPut = false;
    const created = api.saveImportPartition('char:new', newPart, { kind: 'char', entry: { id: 'new', name: 'Alice', partKey: 'char:new' } });
    values = staged; tx.oncomplete(); await created;
    assert.ok(values.get('meta').charIndex.some(e => e.id === 'new'));
    assert.equal(values.get('char:new').outfits[0].id, 'new');

    reset(true);
    await assert.rejects(api.saveImportPartition('user:__default__', newPart), /存储尚未就绪/);
    assert.equal(api.testCache().parts['user:__default__'], oldPart);
    console.log('import storage: pass (durable completion, atomic index/partition writes, abort/quota rollback, initialization guard)');
}
run().catch(error => { console.error(error); process.exitCode = 1; });
