// ── 穿搭管理器 · 存储层 v3 ────────────────────────────────
// 分包存储架构：meta + partition 独立 key
// IndexedDB 本地分包 + Server 后端全量兼容（Phase 1）
// meta: 全局设置/索引/激活追踪
// partition: { outfits, categories, activeIds } 按 user/char 独立存储

import { defMeta, defPartition, ensureMetaDefaults, ensurePartDefaults, migrateCategories, SHARED_CHAR_KEY } from './data.js';

// 8位随机ID生成（用于 charId / presetId）
var ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function genId8() {
    var s = '';
    for (var i = 0; i < 8; i++) s += ID_CHARS.charAt(Math.floor(Math.random() * ID_CHARS.length));
    return s;
}
export { genId8 };

// ── 常量 ─────────────────────────────────────────────────
var DB_NAME = 'outfit_mgr_db';
var DB_VERSION = 1;
var STORE_NAME = 'data';
var LS_KEY = 'outfit_mgr_v4';
var SERVER_SEEN_KEY = 'outfit_mgr_server_seen';

// v1 旧 key（迁移用）
var LEGACY_DATA_KEY = 'main';

var SERVER_BASE = '/api/plugins/outfit-manager';
var IMAGE_URL_PREFIX = SERVER_BASE + '/images/';
var MIN_SERVER_PLUGIN_VERSION = '2.0.3';

// ── 内存缓存 ─────────────────────────────────────────────
var dbInstance = null;
var metaCache = null;           // meta 对象
var partCache = {};             // { partKey: partition }
var serverMode = false;
var serverVersion = 1;
var serverPluginVersion = null;
var serverPluginUpdateRecommended = false;
var serverSupportsPartitions = false;
var serverSupportsRecovery = false;
var serverSupportsPartitionTransactions = false;
// v2 后端必须完整 hydrate 后才能写。读取失败绝不能被当作“空数据”后反向覆盖服务器。
var serverHydrated = false;
var serverInitFailed = false;
var lastInitializationError = null;
var serverRecoveryRevision = null;
var serverStorageState = null;
var serverRecoveryResult = null;
var suppressServerWrites = false;
var csrfToken = null;

// server PUT 防抖（v1 全量模式）
var serverDirty = false;
var serverRevision = 0;
var serverDebounceTimer = null;
var serverPutInFlight = false;
var SERVER_DEBOUNCE_MS = 1000;

// server PUT 防抖（v2 分包模式）
var dirtyPartKeys = {};         // { partKey: latestRevision }
var partRevisions = {};         // 单调 revision；失败时只重试当前最新值
var partFlushTimer = null;
var partFlushInFlight = false;
var deletedPartKeys = {};       // tombstone：已删除的 key，防止 in-flight PUT 复活
var pendingPartitionDeletes = {}; // meta/local commit 后才真正删除 partition
var partitionDeleteRetryTimer = null;
var SERVER_READ_MAX_ATTEMPTS = 3;
var SERVER_READ_RETRY_MS = 150;
var checkpointTimer = null;

function isPluginVersionAtLeast(value, minimum) {
    var actual = typeof value === 'string' ? value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/) : null;
    var required = typeof minimum === 'string' ? minimum.match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
    if (!actual || !required) return false;
    for (var i = 1; i <= 3; i++) {
        var left = Number(actual[i]);
        var right = Number(required[i]);
        if (left > right) return true;
        if (left < right) return false;
    }
    // A prerelease of the minimum stable version is not considered current.
    return !actual[4];
}

// ══════════════════════════════════════════════════════════
//  IndexedDB 底层
// ══════════════════════════════════════════════════════════

function openDB(cb) {
    if (dbInstance) { cb(dbInstance); return; }
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = function (e) { dbInstance = e.target.result; cb(dbInstance); };
    req.onerror = function () { cb(null); };
}

// 通用：读单个 key
function idbGet(key, cb) {
    openDB(function (db) {
        if (!db) { cb(null); return; }
        var tx = db.transaction(STORE_NAME, 'readonly');
        var req = tx.objectStore(STORE_NAME).get(key);
        req.onsuccess = function () { cb(req.result !== undefined ? req.result : null); };
        req.onerror = function () { cb(null); };
    });
}

// 通用：写单个 key
function idbPut(key, value, cb) {
    openDB(function (db) {
        if (!db) { if (cb) cb(false); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(value, key);
        tx.oncomplete = function () { if (cb) cb(true); };
        tx.onerror = function () { if (cb) cb(false); };
    });
}

// 通用：删除单个 key
function idbDelete(key, cb) {
    openDB(function (db) {
        if (!db) { if (cb) cb(false); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = function () { if (cb) cb(true); };
        tx.onerror = function () { if (cb) cb(false); };
    });
}

// 通用：批量写多个 key（同一事务）
function idbPutBatch(entries, cb) {
    openDB(function (db) {
        if (!db) { if (cb) cb(); return; }
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        entries.forEach(function (e) { store.put(e.value, e.key); });
        tx.oncomplete = function () { if (cb) cb(); };
        tx.onerror = function () { if (cb) cb(); };
    });
}

// 通用：读取所有 key（迁移检测用）
function idbGetAllKeys(cb) {
    openDB(function (db) {
        if (!db) { cb([]); return; }
        var tx = db.transaction(STORE_NAME, 'readonly');
        var store = tx.objectStore(STORE_NAME);
        if (store.getAllKeys) {
            var req = store.getAllKeys();
            req.onsuccess = function () { cb(req.result || []); };
            req.onerror = function () { cb([]); };
        } else {
            // fallback for older browsers
            var keys = [];
            var cursor = store.openKeyCursor();
            cursor.onsuccess = function (e) {
                var c = e.target.result;
                if (c) { keys.push(c.key); c.continue(); }
                else cb(keys);
            };
            cursor.onerror = function () { cb(keys); };
        }
    });
}

// ══════════════════════════════════════════════════════════
//  Server 通信
// ══════════════════════════════════════════════════════════

function getWriteHeaders() {
    function addRecoveryRevision(headers) {
        if (!headers || !serverRecoveryRevision) return headers;
        if (typeof headers.set === 'function') headers.set('X-OM-Recovery-Revision', serverRecoveryRevision);
        else headers['X-OM-Recovery-Revision'] = serverRecoveryRevision;
        return headers;
    }
    try {
        if (typeof window !== 'undefined' && typeof window.getRequestHeaders === 'function') {
            var h = window.getRequestHeaders();
            if (h) {
                if (typeof h.set === 'function') h.set('Content-Type', 'application/json');
                else h['Content-Type'] = 'application/json';
                return Promise.resolve(addRecoveryRevision(h));
            }
        }
    } catch (e) {}
    var base = { 'Content-Type': 'application/json' };
    if (csrfToken) { base['X-CSRF-Token'] = csrfToken; return Promise.resolve(addRecoveryRevision(base)); }
    return fetch('/csrf-token', { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
            if (j && j.token) { csrfToken = j.token; base['X-CSRF-Token'] = j.token; }
            return addRecoveryRevision(base);
        })
        .catch(function () { return addRecoveryRevision(base); });
}

function createServerCheckpoint() {
    if (!serverMode || !serverSupportsPartitions || !serverSupportsRecovery || !serverHydrated || serverInitFailed) return;
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/recovery/checkpoints', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({})
        });
    }).catch(function () {});
}

function scheduleServerCheckpoint() {
    if (!serverMode || !serverSupportsPartitions || !serverSupportsRecovery || !serverHydrated || serverInitFailed) return;
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(function () {
        checkpointTimer = null;
        createServerCheckpoint();
    }, SERVER_DEBOUNCE_MS);
}

function detectServer(cb) {
    var serverWasConfirmed = wasServerPreviouslyConfirmed();
    retryServerRead('server status', function () {
        return fetchServerJson(SERVER_BASE + '/status').then(function (result) {
            if (!result.ok || !result.found) return result;
            var body = result.data;
            if (!body || typeof body !== 'object' || body.ok !== true) {
                return serverReadFailure('unexpected_response', result.status, 'Invalid status response', false);
            }
            return result;
        });
    }, function (result) {
        if (result.ok && !result.found) {
            forgetConfirmedServer();
            serverPluginVersion = null;
            serverPluginUpdateRecommended = false;
            serverRecoveryRevision = null;
            serverSupportsRecovery = false;
            serverSupportsPartitionTransactions = false;
            serverStorageState = null;
            serverRecoveryResult = null;
            cb({ installed: false, ok: true, status: 404, kind: 'not_installed', error: null, attempts: result.attempts });
            return;
        }
        if (!result.ok) {
            // 纯前端环境对不存在的插件路由不一定返回标准 404，也可能表现为网络、
            // 代理或 HTML 解析错误。只有曾成功识别过后端，才把这类失败升级为恢复锁定。
            if (!serverWasConfirmed) {
                serverPluginVersion = null;
                serverPluginUpdateRecommended = false;
                serverRecoveryRevision = null;
                serverSupportsRecovery = false;
                try { console.warn('[outfit-manager] 未确认安装后端，已使用本地存储模式。', result); } catch (e) {}
                cb({
                    installed: false,
                    ok: true,
                    status: result.status,
                    kind: 'not_confirmed',
                    error: result.error,
                    attempts: result.attempts
                });
                return;
            }
            cb({
                installed: true,
                ok: false,
                status: result.status,
                kind: result.kind,
                error: result.error,
                attempts: result.attempts
            });
            return;
        }
        var body = result.data;
        serverVersion = body.version || 1;
        serverPluginVersion = typeof body.pluginVersion === 'string' ? body.pluginVersion : null;
        serverPluginUpdateRecommended = !isPluginVersionAtLeast(serverPluginVersion, MIN_SERVER_PLUGIN_VERSION);
        serverSupportsPartitions = serverVersion >= 2 && body.partitions === true;
        serverSupportsRecovery = Number(body.recovery || 0) >= 1;
        serverSupportsPartitionTransactions = body.partitionTransactions === true;
        serverRecoveryRevision = typeof body.recoveryRevision === 'string' ? body.recoveryRevision : null;
        serverStorageState = typeof body.storageState === 'string' ? body.storageState : null;
        serverRecoveryResult = body.recoveryResult && typeof body.recoveryResult === 'object' ? body.recoveryResult : null;
        rememberConfirmedServer();
        cb({ installed: true, ok: true, status: result.status, kind: null, error: null, attempts: result.attempts });
    });
}

function wasServerPreviouslyConfirmed() {
    try { return localStorage.getItem(SERVER_SEEN_KEY) === '1'; }
    catch (e) { return false; }
}

function rememberConfirmedServer() {
    try { localStorage.setItem(SERVER_SEEN_KEY, '1'); } catch (e) {}
}

function forgetConfirmedServer() {
    try { localStorage.removeItem(SERVER_SEEN_KEY); } catch (e) {}
}

function serverGetData(cb) {
    fetch(SERVER_BASE + '/data', { method: 'GET', credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { cb((j && j.ok) ? (j.data || null) : null); })
        .catch(function () { cb(null); });
}

// Phase 1: server 仍然是完整 JSON 读写
// 确保所有 partition 都加载完再重组，防止未加载 partition 被空数组覆盖
function serverPutFull() {
    if (serverPutInFlight) { serverDirty = true; return; }
    // 先收集所有需要的 partition key
    var meta = metaCache || defMeta();
    var allKeys = ['user:__default__'];
    (meta.presets || []).forEach(function (pi) { if (allKeys.indexOf(pi.partKey) === -1) allKeys.push(pi.partKey); });
    (meta.charIndex || []).forEach(function (ci) { if (allKeys.indexOf(ci.partKey) === -1) allKeys.push(ci.partKey); });
    // 活跃预设
    var activePK = currentUserPartKey();
    if (allKeys.indexOf(activePK) === -1) allKeys.push(activePK);

    // 找出未加载的 partition
    var missing = allKeys.filter(function (k) { return !partCache[k]; });
    if (missing.length === 0) {
        doServerPut();
        return;
    }
    // 加载缺失的 partition 再 PUT
    var pending = missing.length;
    missing.forEach(function (pk) {
        idbGet(pk, function (raw) {
            if (raw) partCache[pk] = ensurePartDefaults(raw);
            pending--;
            if (pending === 0) doServerPut();
        });
    });
}

function doServerPut() {
    var full = reassembleFullData();
    var raw;
    try { raw = JSON.stringify(full); }
    catch (err) { serverDirty = true; scheduleServerPutRetry(); return; }
    serverPutInFlight = true;
    var revisionAtDispatch = serverRevision;
    var succeeded = false;
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/data', {
            method: 'PUT',
            credentials: 'same-origin',
            headers: headers,
            body: raw
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
        succeeded = !!(r && r.ok);
    }).catch(function () { succeeded = false; }).then(function () {
        serverPutInFlight = false;
        if (!succeeded || revisionAtDispatch !== serverRevision) serverDirty = true;
        if (serverDirty) {
            scheduleServerPutRetry();
        }
    });
}

function scheduleServerPutRetry() {
    if (serverDebounceTimer) clearTimeout(serverDebounceTimer);
    serverDebounceTimer = setTimeout(function () {
        serverDebounceTimer = null;
        if (serverPutInFlight || !serverDirty) return;
        serverDirty = false;
        serverPutFull();
    }, SERVER_DEBOUNCE_MS);
}

function scheduleServerPut() {
    if (!serverMode) return;
    serverRevision++;
    serverDirty = true;
    if (serverDebounceTimer) clearTimeout(serverDebounceTimer);
    scheduleServerPutRetry();
}

// ── v2 分包模式 server 通信 ─────────────────────────────

// 统一调度：根据后端版本选择全量或分包
function scheduleServerPutKey(key) {
    if (!serverMode) return;
    if (suppressServerWrites) return;
    if (!serverSupportsPartitions) {
        scheduleServerPut(); // v1 后端走全量
        return;
    }
    if (!serverHydrated || serverInitFailed) return;
    var revision = (partRevisions[key] || 0) + 1;
    partRevisions[key] = revision;
    dirtyPartKeys[key] = revision;
    schedulePartitionFlush();
}

function schedulePartitionFlush(delay) {
    if (partFlushTimer) clearTimeout(partFlushTimer);
    partFlushTimer = setTimeout(function () {
        partFlushTimer = null;
        flushDirtyPartitions();
    }, delay === undefined ? SERVER_DEBOUNCE_MS : delay);
}

// 批量 flush 所有 dirty key
function flushDirtyPartitions() {
    if (serverSupportsPartitions && (!serverHydrated || serverInitFailed)) {
        dirtyPartKeys = {};
        return;
    }
    if (partFlushInFlight) return;
    var keys = Object.keys(dirtyPartKeys).sort(function (a, b) {
        if (a === 'meta') return 1;
        if (b === 'meta') return -1;
        return a.localeCompare(b);
    });
    if (keys.length === 0) return;
    var batch = keys.map(function (key) { return { key: key, revision: dirtyPartKeys[key] }; });
    dirtyPartKeys = {};
    partFlushInFlight = true;
    var allSucceeded = true;
    var index = 0;

    function finish() {
        partFlushInFlight = false;
        if (allSucceeded) scheduleServerCheckpoint();
        if (Object.keys(dirtyPartKeys).length > 0) schedulePartitionFlush(allSucceeded ? 0 : SERVER_DEBOUNCE_MS);
    }

    function next() {
        if (index >= batch.length) { finish(); return; }
        var entry = batch[index++];
        var key = entry.key;
        // 跳过已被删除的 key（tombstone 防复活）
        if (deletedPartKeys[key]) { next(); return; }
        var data = (key === 'meta') ? metaCache : partCache[key];
        if (!data) { next(); return; }
        serverPutPartition(key, data, function (ok) {
            if (!ok) {
                allSucceeded = false;
                var latest = partRevisions[key] || entry.revision;
                if (!deletedPartKeys[key]) dirtyPartKeys[key] = latest;
            } else if (key === 'meta' && partRevisions[key] === entry.revision) {
                // 只有当前最新 meta revision 成功后，才能提交此前登记的分包删除。
                commitPendingPartitionDeletes(true);
            }
            next();
        });
    }
    var metaEntry = batch.find(function (entry) { return entry.key === 'meta'; });
    if (metaEntry && serverSupportsPartitionTransactions) {
        serverPutPartitionDataset(function (ok) {
            if (!ok) {
                allSucceeded = false;
                batch.forEach(function (entry) {
                    if (!deletedPartKeys[entry.key]) dirtyPartKeys[entry.key] = partRevisions[entry.key] || entry.revision;
                });
            } else if (partRevisions.meta === metaEntry.revision) {
                markDatasetDeletesCommitted();
            }
            finish();
        });
        return;
    }
    next();
}

function serverPutPartitionDataset(cb) {
    var meta = metaCache || defMeta();
    var partitions = {};
    var keys = collectRequiredPartKeys(meta);
    for (var i = 0; i < keys.length; i++) {
        if (!partCache[keys[i]]) { cb(false); return; }
        partitions[keys[i]] = partCache[keys[i]];
    }
    var raw;
    try { raw = JSON.stringify({ meta: meta, partitions: partitions }); }
    catch (err) { cb(false); return; }
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/partitions/batch', {
            method: 'PUT', credentials: 'same-origin', headers: headers, body: raw
        });
    }).then(function (res) {
        if (res && res.status === 403) csrfToken = null;
        cb(!!(res && res.ok));
    }).catch(function () { cb(false); });
}

// PUT 单个 partition 到 v2 后端
function serverPutPartition(key, data, cb) {
    if (!serverHydrated || serverInitFailed) { if (cb) cb(false); return; }
    var raw;
    try { raw = JSON.stringify(data); }
    catch (err) { if (cb) cb(false); return; }
    var succeeded = false;
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/partitions/' + encodeURIComponent(key), {
            method: 'PUT',
            credentials: 'same-origin',
            headers: headers,
            body: raw
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
        succeeded = !!(r && r.ok);
    }).catch(function () { succeeded = false; }).then(function () {
        if (cb) cb(succeeded);
    });
}

function metaReferencesPartition(key) {
    if (key === 'user:__default__') return true;
    var meta = metaCache || {};
    var referenced = false;
    (meta.presets || []).forEach(function (item) { if (item && item.partKey === key) referenced = true; });
    (meta.charIndex || []).forEach(function (item) { if (item && item.partKey === key) referenced = true; });
    return referenced;
}

function commitPendingPartitionDeletes(serverSide) {
    function retry() {
        if (partitionDeleteRetryTimer) return;
        partitionDeleteRetryTimer = setTimeout(function () {
            partitionDeleteRetryTimer = null;
            commitPendingPartitionDeletes(serverMode && serverSupportsPartitions);
        }, SERVER_DEBOUNCE_MS);
    }
    function finishIfDone(key, pending) {
        var serverDone = !serverMode || !serverSupportsPartitions || pending.serverCommitted;
        if (pending.localCommitted && serverDone) delete pendingPartitionDeletes[key];
    }
    Object.keys(pendingPartitionDeletes).forEach(function (key) {
        var pending = pendingPartitionDeletes[key];
        if (!pending || metaReferencesPartition(key)) return;
        if (!pending.localCommitted && !pending.localInFlight) {
            pending.localInFlight = true;
            idbDelete(key, function (ok) {
                pending.localInFlight = false;
                pending.localCommitted = !!ok;
                if (!ok) retry();
                finishIfDone(key, pending);
            });
        }
        if (serverSide && serverMode && serverSupportsPartitions && !pending.serverCommitted && !pending.serverInFlight) {
            pending.serverInFlight = true;
            sendDeletePartition(key, function (ok) {
                pending.serverInFlight = false;
                pending.serverCommitted = !!ok;
                if (!ok) {
                    retry();
                    return;
                }
                finishIfDone(key, pending);
            });
        }
        finishIfDone(key, pending);
    });
}

function markDatasetDeletesCommitted() {
    Object.keys(pendingPartitionDeletes).forEach(function (key) {
        var pending = pendingPartitionDeletes[key];
        if (pending && !metaReferencesPartition(key)) pending.serverCommitted = true;
    });
    commitPendingPartitionDeletes(false);
}

// 旧 v2 后端没有 batch 事务时，meta 成功后才会走这个兼容 DELETE。
function sendDeletePartition(key, cb) {
    if (!serverHydrated || serverInitFailed) { if (cb) cb(false); return; }
    var succeeded = false;
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/partitions/' + encodeURIComponent(key), {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: headers
        });
    }).then(function (r) {
        if (r && r.status === 403) { csrfToken = null; }
        succeeded = !!(r && r.ok);
    }).catch(function () { succeeded = false; }).then(function () {
        if (succeeded) scheduleServerCheckpoint();
        if (cb) cb(succeeded);
    });
}

function serverReadFailure(kind, status, error, retryable) {
    return {
        ok: false,
        status: status || 0,
        found: false,
        data: null,
        error: error || kind,
        kind: kind,
        retryable: !!retryable
    };
}

// 读取响应必须保留 404、500、网络错误、解析错误等语义；一个 null 无法安全表示这些状态。
function fetchServerJson(url) {
    return fetch(url, { method: 'GET', credentials: 'same-origin' }).then(function (r) {
        if (!r || typeof r.status !== 'number') {
            return serverReadFailure('unexpected_response', 0, 'Missing HTTP response', false);
        }
        if (r.status === 404) {
            return { ok: true, status: 404, found: false, data: null, error: null, kind: 'not_found', retryable: false };
        }
        if (!r.ok) {
            return serverReadFailure('http_error', r.status, 'HTTP ' + r.status, r.status >= 500);
        }
        return r.json().then(function (body) {
            return { ok: true, status: r.status, found: true, data: body, error: null, kind: null, retryable: false };
        }, function (err) {
            return serverReadFailure('parse_error', r.status, err && err.message ? err.message : 'Invalid JSON', true);
        });
    }, function (err) {
        return serverReadFailure('network_error', 0, err && err.message ? err.message : 'Network error', true);
    });
}

function retryServerRead(label, readFn, cb, attempt) {
    var n = attempt || 1;
    function handleResult(result) {
        if (!result.ok && result.retryable && n < SERVER_READ_MAX_ATTEMPTS) {
            try { console.warn('[outfit-manager] ' + label + ' 读取失败，准备重试 (' + n + '/' + SERVER_READ_MAX_ATTEMPTS + '):', result.error); } catch (e) {}
            setTimeout(function () { retryServerRead(label, readFn, cb, n + 1); }, SERVER_READ_RETRY_MS * n);
            return;
        }
        result.attempts = n;
        cb(result);
    }
    var request;
    try { request = readFn(); }
    catch (err) { handleResult(serverReadFailure('network_error', 0, err && err.message, true)); return; }
    Promise.resolve(request).then(handleResult, function (err) {
        handleResult(serverReadFailure('network_error', 0, err && err.message, true));
    });
}

// GET 单个 partition（v2 启动加载用）
function serverGetPartition(key, cb) {
    var label = 'partition ' + key;
    retryServerRead(label, function () {
        return fetchServerJson(SERVER_BASE + '/partitions/' + encodeURIComponent(key)).then(function (result) {
            if (!result.ok || !result.found) return result;
            var body = result.data;
            if (!body || typeof body !== 'object' || body.ok !== true || !Object.prototype.hasOwnProperty.call(body, 'data')) {
                return serverReadFailure('unexpected_response', result.status, 'Unexpected partition response', false);
            }
            // 旧 v2 后端以 200 + data:null 表示文件不存在；保留 found=false，由初始化上下文决定是否安全。
            if (body.data === null || body.data === undefined) {
                return { ok: true, status: result.status, found: false, data: null, error: null, kind: 'legacy_null', retryable: false, legacyNull: true };
            }
            return { ok: true, status: result.status, found: true, data: body.data, error: null, kind: null, retryable: false };
        });
    }, cb);
}

// GET /partitions/keys（v2 启动用）
function serverGetPartitionKeys(cb) {
    retryServerRead('partition keys', function () {
        return fetchServerJson(SERVER_BASE + '/partitions/keys').then(function (result) {
            if (!result.ok) return result;
            if (!result.found) return serverReadFailure('not_found', result.status, 'Partition keys endpoint not found', false);
            var body = result.data;
            if (!body || typeof body !== 'object' || body.ok !== true || !Array.isArray(body.keys)) {
                return serverReadFailure('unexpected_response', result.status, 'Unexpected partition keys response', false);
            }
            return { ok: true, status: result.status, found: true, data: body.keys, error: null, kind: null, retryable: false };
        });
    }, cb);
}

// 从内存重组 v1 格式的完整数据（server 兼容用）
function reassembleFullData() {
    var meta = metaCache || defMeta();
    var d = {};

    // 设置字段
    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'fabPos', 'tagOrder',
        'currentView', 'currentChar'
    ];
    settingsKeys.forEach(function (k) { if (meta[k] !== undefined) d[k] = meta[k]; });

    // currentChar: 还原为角色名
    if (meta.currentChar && meta.charIndex) {
        var found = null;
        for (var i = 0; i < meta.charIndex.length; i++) {
            if (meta.charIndex[i].id === meta.currentChar) { found = meta.charIndex[i].name; break; }
        }
        d.currentChar = found || '';
    }

    // User 默认预设
    var activePartKey = currentUserPartKey();
    var userPart = partCache[activePartKey] || defPartition();
    d.outfits = userPart.outfits || [];
    d.categories = userPart.categories || [];
    d.activeIds = userPart.activeIds || [];
    d.accessories = userPart.accessories || [];
    d.accCategories = userPart.accCategories || [];

    // 预设：重组为旧格式（presets 数组内嵌 outfits）
    d.presets = [];
    d.activePresetId = meta.activePresetId || null;
    (meta.presets || []).forEach(function (pi) {
        var pp = partCache[pi.partKey] || null;
        if (pp) {
            d.presets.push({
                id: pi.id,
                name: pi.name,
                outfits: pp.outfits || [],
                categories: pp.categories || [],
                activeIds: pp.activeIds || [],
                accessories: pp.accessories || [],
                accCategories: pp.accCategories || []
            });
        } else {
            // partition 未加载时写索引占位
            d.presets.push({ id: pi.id, name: pi.name, outfits: [], categories: [], activeIds: [], accessories: [], accCategories: [] });
        }
    });

    // Char 数据
    d.chars = {};
    d.charNames = [];
    d.charFavorites = [];
    d.charGroups = {};

    if (meta.charIndex) {
        meta.charIndex.forEach(function (ci) {
            var name = ci.name;
            var partKey = ci.partKey;
            if (ci.id === SHARED_CHAR_KEY) {
                // 通用衣柜
                var sp = partCache[partKey] || defPartition();
                d.chars[SHARED_CHAR_KEY] = { outfits: sp.outfits || [], categories: sp.categories || [], activeIds: sp.activeIds || [], accessories: sp.accessories || [], accCategories: sp.accCategories || [] };
            } else {
                d.charNames.push(name);
                var cp = partCache[partKey] || defPartition();
                d.chars[name] = { outfits: cp.outfits || [], categories: cp.categories || [], activeIds: cp.activeIds || [], accessories: cp.accessories || [], accCategories: cp.accCategories || [] };
            }
        });
    }

    // charFavorites: id → name
    if (meta.charFavorites && meta.charIndex) {
        meta.charFavorites.forEach(function (cid) {
            for (var j = 0; j < meta.charIndex.length; j++) {
                if (meta.charIndex[j].id === cid) { d.charFavorites.push(meta.charIndex[j].name); break; }
            }
        });
    }

    // charGroups: id → name
    if (meta.charGroups && meta.charIndex) {
        for (var gn in meta.charGroups) {
            d.charGroups[gn] = [];
            (meta.charGroups[gn] || []).forEach(function (cid) {
                for (var j = 0; j < meta.charIndex.length; j++) {
                    if (meta.charIndex[j].id === cid) { d.charGroups[gn].push(meta.charIndex[j].name); break; }
                }
            });
        }
    }

    return d;
}

// ══════════════════════════════════════════════════════════
//  Meta 读写
// ══════════════════════════════════════════════════════════

function normalizeSharedCharState(meta) {
    var changed = false;
    if (!Array.isArray(meta.charIndex)) { meta.charIndex = []; changed = true; }

    var cleaned = [];
    var sharedEntry = null;
    var sharedPartKey = 'char:__shared__';
    var sharedPart = partCache[sharedPartKey] || null;
    var removedPartKeys = [];
    var removedCharIds = [];
    var hasCurrent = false;
    meta.charIndex.forEach(function (ci) {
        if (!ci) return;
        if (ci.id === SHARED_CHAR_KEY) {
            if (!sharedEntry) {
                sharedEntry = ci;
                if (ci.name !== SHARED_CHAR_KEY) { ci.name = SHARED_CHAR_KEY; changed = true; }
                if (ci.partKey !== sharedPartKey) { ci.partKey = sharedPartKey; changed = true; }
                cleaned.push(ci);
            } else {
                changed = true;
            }
            if (ci.id === meta.currentChar) hasCurrent = true;
            return;
        }
        if (ci.name === SHARED_CHAR_KEY) {
            if (ci.partKey && partCache[ci.partKey]) {
                if (!sharedPart) sharedPart = loadPartition(sharedPartKey);
                mergePartitionInto(sharedPart, partCache[ci.partKey]);
                removedPartKeys.push(ci.partKey);
            }
            if (ci.id === meta.currentChar) meta.currentChar = SHARED_CHAR_KEY;
            if (ci.id) removedCharIds.push(ci.id);
            changed = true;
            return;
        }
        if (ci.id === meta.currentChar) hasCurrent = true;
        cleaned.push(ci);
    });
    if (!sharedEntry) {
        cleaned.unshift({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: sharedPartKey });
        changed = true;
    }
    if (cleaned.length !== meta.charIndex.length) changed = true;
    meta.charIndex = cleaned;
    removedPartKeys.forEach(function (partKey) {
        deletePartition(partKey);
        if (meta.activePartitions) delete meta.activePartitions[partKey];
    });
    if (removedCharIds.length > 0) {
        if (Array.isArray(meta.charFavorites)) {
            meta.charFavorites = meta.charFavorites.filter(function (id) { return removedCharIds.indexOf(id) === -1; });
        }
        if (meta.charGroups) {
            for (var gn in meta.charGroups) {
                meta.charGroups[gn] = (meta.charGroups[gn] || []).filter(function (id) { return removedCharIds.indexOf(id) === -1; });
            }
        }
    }
    if (meta.currentView === 'char' && (!meta.currentChar || !hasCurrent)) {
        meta.currentChar = SHARED_CHAR_KEY;
        changed = true;
    }
    return changed;
}

function mergePartitionInto(target, source) {
    if (!target || !source) return;
    if (!Array.isArray(target.outfits)) target.outfits = [];
    if (!Array.isArray(target.categories)) target.categories = [];
    if (!Array.isArray(target.activeIds)) target.activeIds = [];
    if (!Array.isArray(target.accessories)) target.accessories = [];
    if (!Array.isArray(target.accCategories)) target.accCategories = [];

    function hasItem(list, item) {
        for (var i = 0; i < list.length; i++) {
            if (item.id && list[i].id === item.id) return true;
            if (item.name && list[i].name === item.name) return true;
        }
        return false;
    }
    function catName(c) { return c && typeof c === 'object' ? c.name : c; }
    function mergeCats(list, incoming) {
        (incoming || []).forEach(function (c) {
            var name = catName(c);
            var exists = false;
            for (var i = 0; i < list.length; i++) {
                if (catName(list[i]) === name) { exists = true; break; }
            }
            if (!exists) list.push(c);
        });
    }
    (source.outfits || []).forEach(function (o) { if (o && !hasItem(target.outfits, o)) target.outfits.push(o); });
    (source.accessories || []).forEach(function (a) { if (a && !hasItem(target.accessories, a)) target.accessories.push(a); });
    mergeCats(target.categories, source.categories);
    mergeCats(target.accCategories, source.accCategories);
    (source.activeIds || []).forEach(function (id) {
        if (target.activeIds.indexOf(id) === -1) target.activeIds.push(id);
    });
    savePartition('char:__shared__', target);
    syncActivePartitions('char:__shared__', target.activeIds);
}

export function loadMeta() {
    if (serverInitFailed) {
        throw new Error('Outfit Manager server initialization failed');
    }
    if (!metaCache) metaCache = defMeta();
    // v2 hydrate 期间禁止 normalize 触发 save/delete；成功打开写门后再做兼容规范化。
    if (serverMode && serverSupportsPartitions && !serverHydrated) return metaCache;
    if (normalizeSharedCharState(metaCache)) saveMeta(metaCache);
    return metaCache;
}

export function saveMeta(meta) {
    if (serverInitFailed) return false;
    metaCache = meta;
    idbPut('meta', meta, function (ok) {
        if (ok) commitPendingPartitionDeletes(false);
    });
    scheduleServerPutKey('meta');
    return true;
}

// ══════════════════════════════════════════════════════════
//  Partition 读写
// ══════════════════════════════════════════════════════════

// 同步读（从缓存，必须已 ensure 过）
export function loadPartition(partKey) {
    if (serverInitFailed) {
        throw new Error('Outfit Manager server initialization failed');
    }
    if (!partCache[partKey]) partCache[partKey] = defPartition();
    return partCache[partKey];
}

// 写 partition（本地 IDB + server 防抖）
export function savePartition(partKey, data) {
    if (serverInitFailed) return false;
    partCache[partKey] = data;
    delete deletedPartKeys[partKey];
    delete pendingPartitionDeletes[partKey];
    idbPut(partKey, data);
    scheduleServerPutKey(partKey);
    return true;
}

// Import commits one wardrobe and its index in the same IDB transaction. Cache
// publication and backend scheduling happen only after durable local success.
export function saveImportPartition(partKey, data, registration) {
    return new Promise(function (resolve, reject) {
        if (serverInitFailed || (serverMode && serverSupportsPartitions && !serverHydrated)) {
            reject(new Error('存储尚未就绪，未保存此衣柜')); return;
        }
        var meta = Object.assign({}, loadMeta(), {
            charIndex: (loadMeta().charIndex || []).slice(),
            presets: (loadMeta().presets || []).slice(),
            activePartitions: Object.assign({}, loadMeta().activePartitions)
        });
        if (registration) {
            var list = registration.kind === 'preset' ? meta.presets : meta.charIndex;
            if (!list.some(function (entry) { return entry.id === registration.entry.id; })) list.push(registration.entry);
        }
        if (data.activeIds && data.activeIds.length && (partKey.indexOf('char:') === 0 || partKey === currentUserPartKey())) meta.activePartitions[partKey] = data.activeIds.slice();
        else delete meta.activePartitions[partKey];
        if (partKey === currentUserPartKey()) cleanUserActivePartitions(meta, partKey);
        openDB(function (db) {
            if (!db) { reject(new Error('无法打开本地存储，未保存此衣柜')); return; }
            var tx, finished = false;
            function fail() {
                if (finished) return;
                finished = true;
                reject(new Error('保存失败，可能是存储空间不足；此衣柜未写入，请释放空间后重试'));
            }
            try {
                tx = db.transaction(STORE_NAME, 'readwrite');
                tx.onabort = tx.onerror = fail;
                tx.oncomplete = function () {
                    if (finished) return;
                    finished = true;
                    partCache[partKey] = data;
                    metaCache = meta;
                    delete deletedPartKeys[partKey];
                    delete pendingPartitionDeletes[partKey];
                    scheduleServerPutKey(partKey);
                    scheduleServerPutKey('meta');
                    resolve();
                };
                tx.objectStore(STORE_NAME).put(data, partKey);
                tx.objectStore(STORE_NAME).put(meta, 'meta');
            } catch (error) {
                if (tx) { try { tx.abort(); } catch (ignored) {} }
                fail();
            }
        });
    });
}

// 异步确保 partition 在缓存里（切视角时用）
export function ensurePartition(partKey, cb) {
    if (serverInitFailed) { if (cb) cb(null); return; }
    if (partCache[partKey]) { if (cb) cb(partCache[partKey]); return; }
    idbGet(partKey, function (raw) {
        partCache[partKey] = ensurePartDefaults(raw);
        if (cb) cb(partCache[partKey]);
    });
}

// 删除 partition（角色删除时用）
export function deletePartition(partKey) {
    if (serverInitFailed) return false;
    delete partCache[partKey];
    deletedPartKeys[partKey] = true;
    delete dirtyPartKeys[partKey];
    pendingPartitionDeletes[partKey] = pendingPartitionDeletes[partKey] || {
        localCommitted: false,
        localInFlight: false,
        serverCommitted: false,
        serverInFlight: false
    };
    return true;
}

// ══════════════════════════════════════════════════════════
//  便捷：当前视角
// ══════════════════════════════════════════════════════════

// 当前 User partition key
export function currentUserPartKey() {
    var meta = loadMeta();
    if (meta.activePresetId) {
        // 找到预设索引
        for (var i = 0; i < (meta.presets || []).length; i++) {
            if (meta.presets[i].id === meta.activePresetId) return meta.presets[i].partKey;
        }
    }
    return 'user:__default__';
}

// 当前视角的 partition key
export function currentPartKey() {
    var meta = loadMeta();
    if (meta.currentView === 'char' && meta.currentChar) {
        // currentChar 存的是 charId
        var charId = meta.currentChar;
        if (charId === SHARED_CHAR_KEY) return 'char:__shared__';
        return 'char:' + charId;
    }
    return currentUserPartKey();
}

// 当前视角的 partition（同步读）
export function loadCurrent() {
    return loadPartition(currentPartKey());
}

// 保存当前视角的 partition
export function saveCurrent(data) {
    savePartition(currentPartKey(), data);
}

// ══════════════════════════════════════════════════════════
//  activePartitions 管理
// ══════════════════════════════════════════════════════════

// 更新 meta.activePartitions（选择/取消穿搭时调用）
export function syncActivePartitions(partKey, activeIds) {
    var meta = loadMeta();
    if (!meta.activePartitions) meta.activePartitions = {};
    if (activeIds && activeIds.length > 0) {
        meta.activePartitions[partKey] = activeIds.slice();
    } else {
        delete meta.activePartitions[partKey];
    }
    // 如果是 user:* 的 key，清掉其他 user:* 的记录（同一时刻只有一个 User 预设有效）
    if (partKey.indexOf('user:') === 0) {
        cleanUserActivePartitions(meta, partKey);
    }
    saveMeta(meta);
}

// 清掉除 keepKey 之外的所有 user:* activePartitions
// User 同一时刻只能有一个活跃预设/默认衣柜
function cleanUserActivePartitions(meta, keepKey) {
    if (!meta.activePartitions) return;
    var toDelete = [];
    for (var pk in meta.activePartitions) {
        if (pk.indexOf('user:') === 0 && pk !== keepKey) toDelete.push(pk);
    }
    toDelete.forEach(function (pk) { delete meta.activePartitions[pk]; });
}

// 切预设后调用：确保 activePartitions 只保留当前 User partKey
export function syncCurrentUserActivePartition() {
    var meta = loadMeta();
    var curPK = currentUserPartKey();
    var curPart = loadPartition(curPK);
    if (!meta.activePartitions) meta.activePartitions = {};
    // 设置当前
    if (curPart.activeIds && curPart.activeIds.length > 0) {
        meta.activePartitions[curPK] = curPart.activeIds.slice();
    } else {
        delete meta.activePartitions[curPK];
    }
    // 清掉其他 user:*
    cleanUserActivePartitions(meta, curPK);
    saveMeta(meta);
}

// 注入用：返回所有有激活穿搭的 partition（同步，已预加载）
// 对 user:* 只返回当前活跃预设，忽略其他 user:* 残留
export function loadActivePartitions() {
    var meta = loadMeta();
    var result = {};
    var ap = meta.activePartitions || {};
    var curUserPK = currentUserPartKey();
    for (var pk in ap) {
        if (ap[pk].length > 0 && partCache[pk]) {
            // user:* 只保留当前活跃的那个
            if (pk.indexOf('user:') === 0 && pk !== curUserPK) continue;
            result[pk] = partCache[pk];
        }
    }
    return result;
}

// ══════════════════════════════════════════════════════════
//  charIndex 辅助
// ══════════════════════════════════════════════════════════

export function charNameById(charId) {
    var meta = loadMeta();
    if (charId === SHARED_CHAR_KEY) return SHARED_CHAR_KEY;
    for (var i = 0; i < (meta.charIndex || []).length; i++) {
        if (meta.charIndex[i].id === charId) return meta.charIndex[i].name;
    }
    return '';
}

export function charIdByName(name) {
    var meta = loadMeta();
    for (var i = 0; i < (meta.charIndex || []).length; i++) {
        if (meta.charIndex[i].name === name) return meta.charIndex[i].id;
    }
    return '';
}

export function charPartKey(charId) {
    if (charId === SHARED_CHAR_KEY) return 'char:__shared__';
    return 'char:' + charId;
}

// ══════════════════════════════════════════════════════════
//  图片相关（保留原接口不变）
// ══════════════════════════════════════════════════════════

export function isServerMode() { return serverMode; }
export function getImageUrlPrefix() { return IMAGE_URL_PREFIX; }

export function getStorageHealth() {
    return {
        serverMode: serverMode,
        serverVersion: serverVersion,
        serverPluginVersion: serverPluginVersion,
        minimumServerPluginVersion: MIN_SERVER_PLUGIN_VERSION,
        serverPluginUpdateRecommended: serverPluginUpdateRecommended,
        serverSupportsPartitions: serverSupportsPartitions,
        serverSupportsRecovery: serverSupportsRecovery,
        serverSupportsPartitionTransactions: serverSupportsPartitionTransactions,
        serverStorageState: serverStorageState,
        serverRecoveryResult: serverRecoveryResult,
        serverHydrated: serverHydrated,
        serverInitFailed: serverInitFailed,
        error: lastInitializationError
    };
}

export function diagnoseServerRecovery(cb) {
    fetch(SERVER_BASE + '/recovery/diagnose', {
        method: 'GET',
        credentials: 'same-origin'
    }).then(function (r) {
        if (!r || !r.ok) {
            var err = new Error('恢复诊断接口不可用' + (r && r.status ? '（HTTP ' + r.status + '）' : ''));
            err.status = r && r.status ? r.status : 0;
            throw err;
        }
        return r.json();
    }).then(function (body) {
        if (!body || body.ok !== true) throw new Error('恢复诊断返回了无效结果');
        cb(null, body);
    }).catch(function (err) {
        cb(err, null);
    });
}

export function restoreServerSnapshot(snapshotId, cb) {
    if (!serverMode || !serverSupportsPartitions || !serverInitFailed) {
        cb(new Error('当前状态不允许执行后端恢复'));
        return;
    }
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/recovery/restore', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ snapshotId: snapshotId || null })
        });
    }).then(function (r) {
        return r.json().catch(function () { return null; }).then(function (body) {
            if (!r.ok || !body || body.ok !== true) {
                var message = body && body.error ? body.error : ('恢复失败（HTTP ' + r.status + '）');
                var err = new Error(message);
                err.status = r.status;
                throw err;
            }
            cb(null, body);
        });
    }).catch(function (err) {
        cb(err, null);
    });
}

export function resolveImageForExternal(imageData, cb) {
    if (!imageData || typeof imageData !== 'string') { cb(imageData); return; }
    if (imageData.indexOf('data:image/') === 0) { cb(imageData); return; }
    if (imageData.indexOf(IMAGE_URL_PREFIX) !== 0) { cb(imageData); return; }
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images/batch-fetch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ urls: [imageData] })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.images && j.images[imageData]) cb(j.images[imageData]);
        else cb(imageData);
    }).catch(function () { cb(imageData); });
}

export function batchResolveImages(urls, cb) {
    if (!urls || urls.length === 0) { cb({}); return; }
    var needFetch = [];
    var results = {};
    urls.forEach(function (url) {
        if (!url || typeof url !== 'string') return;
        if (url.indexOf('data:image/') === 0) { results[url] = url; }
        else if (url.indexOf(IMAGE_URL_PREFIX) === 0) { needFetch.push(url); }
        else { results[url] = url; }
    });
    if (needFetch.length === 0) { cb(results); return; }
    var unique = []; var seen = {};
    needFetch.forEach(function (u) { if (!seen[u]) { seen[u] = true; unique.push(u); } });
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images/batch-fetch', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ urls: unique })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.images) { for (var url in j.images) { results[url] = j.images[url]; } }
        needFetch.forEach(function (u) { if (!results[u]) results[u] = u; });
        cb(results);
    }).catch(function () {
        needFetch.forEach(function (u) { if (!results[u]) results[u] = u; });
        cb(results);
    });
}

export function uploadImage(dataUrl, cb) {
    if (!serverMode) { cb(null, dataUrl); return; }
    getWriteHeaders().then(function (headers) {
        return fetch(SERVER_BASE + '/images', {
            method: 'POST',
            credentials: 'same-origin',
            headers: headers,
            body: JSON.stringify({ dataUrl: dataUrl })
        });
    }).then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
        if (j && j.ok && j.url) cb(null, j.url);
        else cb(null, dataUrl);
    }).catch(function () { cb(null, dataUrl); });
}

// ══════════════════════════════════════════════════════════
//  v1 → v2 数据迁移
// ══════════════════════════════════════════════════════════

// v17 兼容（从旧版 data.js 移过来，迁移时一次性执行）
function migrateV17(d) {
    if (!d || !d.outfits) return;
    var userOutfits = [];
    var moved = {};
    d.outfits.forEach(function (o) {
        if (o.owner && o.owner !== 'user') {
            var cn = o.owner;
            if (!moved[cn]) moved[cn] = [];
            delete o.owner;
            moved[cn].push(o);
        } else {
            delete o.owner;
            userOutfits.push(o);
        }
    });
    d.outfits = userOutfits;
    if (!d.chars) d.chars = {};
    if (!d.charNames) d.charNames = [];
    for (var cn in moved) {
        if (!d.chars[cn]) d.chars[cn] = { outfits: [], categories: [], activeIds: [] };
        d.chars[cn].outfits = d.chars[cn].outfits.concat(moved[cn]);
        if (d.charNames.indexOf(cn) === -1) d.charNames.push(cn);
    }
    if (d.charActiveIds) {
        for (var cn2 in d.charActiveIds) {
            if (!d.chars[cn2]) d.chars[cn2] = { outfits: [], categories: [], activeIds: [] };
            d.chars[cn2].activeIds = d.charActiveIds[cn2];
        }
        delete d.charActiveIds;
    }
}

function migrateFromV1(oldData, cb) {
    // 先跑 v17 迁移确保 chars 结构正确
    migrateV17(oldData);

    var meta = defMeta();
    var entries = []; // { key, value } 批量写入

    // ── 提取设置到 meta ──
    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'fabPos', 'tagOrder',
        'currentView'
    ];
    settingsKeys.forEach(function (k) {
        if (oldData[k] !== undefined) meta[k] = oldData[k];
    });

    // ── apiVision 规范化 ──
    if (meta.apiVision) {
        var dv = defMeta().apiVision;
        for (var vk in dv) { if (meta.apiVision[vk] === undefined) meta.apiVision[vk] = dv[vk]; }
        if (meta.apiVision.batchSize && !meta.apiVision.concurrency) {
            meta.apiVision.concurrency = Math.min(meta.apiVision.batchSize, 5);
        }
        delete meta.apiVision.batchSize;
    }

    // ── User 默认预设 ──
    var userDefault = {
        outfits: oldData.outfits || [],
        categories: migrateCategories(oldData.categories || []),
        activeIds: Array.isArray(oldData.activeIds) ? oldData.activeIds : (oldData.activeId ? [oldData.activeId] : []),
        accessories: oldData.accessories || [],
        accCategories: migrateCategories(oldData.accCategories || [])
    };
    entries.push({ key: 'user:__default__', value: userDefault });
    partCache['user:__default__'] = userDefault;

    // ── User 预设 ──
    meta.presets = [];
    meta.activePresetId = oldData.activePresetId || null;
    if (Array.isArray(oldData.presets)) {
        oldData.presets.forEach(function (p) {
            if (!p) return;
            var pid = p.id || ('p_' + genId8());
            var partKey = 'user:' + pid;
            meta.presets.push({ id: pid, name: p.name || '未命名', partKey: partKey });
            var pPart = {
                outfits: p.outfits || [],
                categories: migrateCategories(p.categories || []),
                activeIds: p.activeIds || [],
                accessories: p.accessories || [],
                accCategories: migrateCategories(p.accCategories || [])
            };
            entries.push({ key: partKey, value: pPart });
            partCache[partKey] = pPart;
        });
    }

    // User 激活：旧版的顶层 outfits/categories/activeIds 是当前实际使用的数据
    // 如果有 activePresetId，说明这些顶层数据其实是该预设的当前工作状态
    // 所以要把顶层数据写入该预设的 partition（覆盖预设快照），而不是 __default__
    var activeUserPK = 'user:__default__';
    if (meta.activePresetId) {
        for (var pi2 = 0; pi2 < meta.presets.length; pi2++) {
            if (meta.presets[pi2].id === meta.activePresetId) {
                activeUserPK = meta.presets[pi2].partKey;
                // 用当前顶层数据覆盖预设 partition（顶层才是最新状态）
                var activePPart = {
                    outfits: userDefault.outfits,
                    categories: userDefault.categories,
                    activeIds: userDefault.activeIds,
                    accessories: userDefault.accessories,
                    accCategories: userDefault.accCategories
                };
                // 更新 entries 和 partCache 里对应的 partition
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].key === activeUserPK) {
                        entries[ei].value = activePPart;
                        break;
                    }
                }
                partCache[activeUserPK] = activePPart;
                break;
            }
        }
    }
    if (userDefault.activeIds.length > 0) {
        meta.activePartitions[activeUserPK] = userDefault.activeIds.slice();
    }

    // ── 角色 ──
    meta.charIndex = [];
    var charFavNames = oldData.charFavorites || [];
    var charGroupsOld = oldData.charGroups || {};
    meta.charFavorites = [];
    meta.charGroups = {};

    // 通用衣柜
    if (oldData.chars && oldData.chars[SHARED_CHAR_KEY]) {
        var scd = oldData.chars[SHARED_CHAR_KEY];
        var sharedPart = {
            outfits: scd.outfits || [],
            categories: migrateCategories(scd.categories || []),
            activeIds: scd.activeIds || [],
            accessories: scd.accessories || [],
            accCategories: migrateCategories(scd.accCategories || [])
        };
        meta.charIndex.push({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: 'char:__shared__' });
        entries.push({ key: 'char:__shared__', value: sharedPart });
        partCache['char:__shared__'] = sharedPart;
        if (sharedPart.activeIds.length > 0) {
            meta.activePartitions['char:__shared__'] = sharedPart.activeIds.slice();
        }
    }

    // 普通角色
    var charNames = (oldData.charNames || []).filter(function (name) { return name && name !== SHARED_CHAR_KEY; });
    // 也收集 chars 里有但 charNames 没列出的
    if (oldData.chars) {
        for (var cn in oldData.chars) {
            if (cn !== SHARED_CHAR_KEY && charNames.indexOf(cn) === -1) {
                charNames.push(cn);
            }
        }
    }

    // name → id 映射（迁移用）
    var nameToId = {};
    charNames.forEach(function (name) {
        var cid = 'c_' + genId8();
        // 防碰撞
        while (nameToId[cid]) { cid = 'c_' + genId8(); }
        nameToId[name] = cid;
        var partKey = 'char:' + cid;
        var cd = (oldData.chars && oldData.chars[name]) ? oldData.chars[name] : { outfits: [], categories: [], activeIds: [] };
        var charPart = {
            outfits: cd.outfits || [],
            categories: migrateCategories(cd.categories || []),
            activeIds: cd.activeIds || [],
            accessories: cd.accessories || [],
            accCategories: migrateCategories(cd.accCategories || [])
        };
        meta.charIndex.push({ id: cid, name: name, partKey: partKey });
        entries.push({ key: partKey, value: charPart });
        partCache[partKey] = charPart;
        if (charPart.activeIds.length > 0) {
            meta.activePartitions[partKey] = charPart.activeIds.slice();
        }
    });

    // 迁移 charFavorites: name → id
    charFavNames.forEach(function (name) {
        if (nameToId[name]) meta.charFavorites.push(nameToId[name]);
    });

    // 迁移 charGroups: name → id
    for (var gn in charGroupsOld) {
        meta.charGroups[gn] = [];
        (charGroupsOld[gn] || []).forEach(function (name) {
            if (nameToId[name]) meta.charGroups[gn].push(nameToId[name]);
        });
    }

    // currentChar: name → id
    if (oldData.currentChar) {
        if (oldData.currentChar === SHARED_CHAR_KEY) {
            meta.currentChar = SHARED_CHAR_KEY;
        } else {
            meta.currentChar = nameToId[oldData.currentChar] || '';
        }
    }

    // ── 写入所有 partitions + meta + 备份旧 key ──
    entries.push({ key: 'meta', value: meta });
    // 备份旧数据
    entries.push({ key: 'backup:main:v1:' + Date.now(), value: oldData });

    metaCache = meta;

    idbPutBatch(entries, function () {
        // 删除旧 key
        idbDelete(LEGACY_DATA_KEY, function () {
            try { console.log('[outfit-manager] v1→v2 迁移完成，已创建 ' + entries.length + ' 个分包 key'); } catch (e) {}
            cb();
        });
    });
}

// ══════════════════════════════════════════════════════════
//  Server 数据 → 分包拆解（server 模式启动用）
// ══════════════════════════════════════════════════════════

function splitServerDataToPartitions(serverData, cb) {
    // 和 migrateFromV1 基本一样，但不备份
    migrateV17(serverData);

    var meta = defMeta();
    var entries = [];

    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'fabPos', 'tagOrder',
        'currentView'
    ];
    settingsKeys.forEach(function (k) {
        if (serverData[k] !== undefined) meta[k] = serverData[k];
    });

    if (meta.apiVision) {
        var dv = defMeta().apiVision;
        for (var vk in dv) { if (meta.apiVision[vk] === undefined) meta.apiVision[vk] = dv[vk]; }
        if (meta.apiVision.batchSize) { delete meta.apiVision.batchSize; }
    }

    // User
    var userDefault = {
        outfits: serverData.outfits || [],
        categories: migrateCategories(serverData.categories || []),
        activeIds: Array.isArray(serverData.activeIds) ? serverData.activeIds : [],
        accessories: serverData.accessories || [],
        accCategories: migrateCategories(serverData.accCategories || [])
    };
    entries.push({ key: 'user:__default__', value: userDefault });
    partCache['user:__default__'] = userDefault;

    // 预设
    meta.presets = [];
    meta.activePresetId = serverData.activePresetId || null;
    if (Array.isArray(serverData.presets)) {
        serverData.presets.forEach(function (p) {
            if (!p) return;
            var pid = p.id || ('p_' + genId8());
            var partKey = 'user:' + pid;
            meta.presets.push({ id: pid, name: p.name || '未命名', partKey: partKey });
            var pPart = {
                outfits: p.outfits || [],
                categories: migrateCategories(p.categories || []),
                activeIds: p.activeIds || [],
                accessories: p.accessories || [],
                accCategories: migrateCategories(p.accCategories || [])
            };
            entries.push({ key: partKey, value: pPart });
            partCache[partKey] = pPart;
        });
    }

    // User 激活：同 migrateFromV1 逻辑
    var activeUserPK = 'user:__default__';
    if (meta.activePresetId) {
        for (var pi2 = 0; pi2 < meta.presets.length; pi2++) {
            if (meta.presets[pi2].id === meta.activePresetId) {
                activeUserPK = meta.presets[pi2].partKey;
                var activePPart = {
                    outfits: userDefault.outfits,
                    categories: userDefault.categories,
                    activeIds: userDefault.activeIds,
                    accessories: userDefault.accessories,
                    accCategories: userDefault.accCategories
                };
                for (var ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].key === activeUserPK) {
                        entries[ei].value = activePPart;
                        break;
                    }
                }
                partCache[activeUserPK] = activePPart;
                break;
            }
        }
    }
    if (userDefault.activeIds.length > 0) {
        meta.activePartitions[activeUserPK] = userDefault.activeIds.slice();
    }

    // 角色
    meta.charIndex = [];
    meta.charFavorites = [];
    meta.charGroups = {};
    var nameToId = {};
    var charNames = (serverData.charNames || []).filter(function (name) { return name && name !== SHARED_CHAR_KEY; });
    if (serverData.chars) {
        for (var cn in serverData.chars) {
            if (cn !== SHARED_CHAR_KEY && charNames.indexOf(cn) === -1) charNames.push(cn);
        }
    }

    // 通用衣柜
    if (serverData.chars && serverData.chars[SHARED_CHAR_KEY]) {
        var scd = serverData.chars[SHARED_CHAR_KEY];
        var sharedPart = {
            outfits: scd.outfits || [],
            categories: migrateCategories(scd.categories || []),
            activeIds: scd.activeIds || [],
            accessories: scd.accessories || [],
            accCategories: migrateCategories(scd.accCategories || [])
        };
        meta.charIndex.push({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: 'char:__shared__' });
        entries.push({ key: 'char:__shared__', value: sharedPart });
        partCache['char:__shared__'] = sharedPart;
        if (sharedPart.activeIds.length > 0) meta.activePartitions['char:__shared__'] = sharedPart.activeIds.slice();
    }

    charNames.forEach(function (name) {
        var cid = 'c_' + genId8();
        nameToId[name] = cid;
        var partKey = 'char:' + cid;
        var cd = (serverData.chars && serverData.chars[name]) || { outfits: [], categories: [], activeIds: [] };
        var charPart = {
            outfits: cd.outfits || [],
            categories: migrateCategories(cd.categories || []),
            activeIds: cd.activeIds || [],
            accessories: cd.accessories || [],
            accCategories: migrateCategories(cd.accCategories || [])
        };
        meta.charIndex.push({ id: cid, name: name, partKey: partKey });
        entries.push({ key: partKey, value: charPart });
        partCache[partKey] = charPart;
        if (charPart.activeIds.length > 0) meta.activePartitions[partKey] = charPart.activeIds.slice();
    });

    // favorites / groups
    (serverData.charFavorites || []).forEach(function (name) {
        if (nameToId[name]) meta.charFavorites.push(nameToId[name]);
    });
    for (var gn in (serverData.charGroups || {})) {
        meta.charGroups[gn] = [];
        (serverData.charGroups[gn] || []).forEach(function (name) {
            if (nameToId[name]) meta.charGroups[gn].push(nameToId[name]);
        });
    }

    if (serverData.currentChar) {
        if (serverData.currentChar === SHARED_CHAR_KEY) meta.currentChar = SHARED_CHAR_KEY;
        else meta.currentChar = nameToId[serverData.currentChar] || '';
    }

    entries.push({ key: 'meta', value: meta });
    metaCache = meta;

    idbPutBatch(entries, function () {
        if (cb) cb();
    });
}

// ══════════════════════════════════════════════════════════
//  预加载所有 partition（兼容期必须全部加载）
// ══════════════════════════════════════════════════════════
// 兼容期间旧 UI 通过 load() 拿到所有 chars 的浅引用，
// save(d) 会遍历 d.chars 写回各 partition。
// 如果某个 partition 没加载，load() 会给空数组，
// save(d) 就会把空数组写回去 → 数据丢失。
// 所以兼容期启动时必须加载所有 partition，不能只加载 active/current。
// 等所有 UI 模块改用新 API 后，可以改回 preloadActivePartitions。

function preloadAllPartitions(cb) {
    var meta = loadMeta();
    var keys = [];

    // user:__default__
    if (keys.indexOf('user:__default__') === -1) keys.push('user:__default__');

    // 当前活跃 User 预设
    var curUPK = currentUserPartKey();
    if (keys.indexOf(curUPK) === -1) keys.push(curUPK);

    // 所有 User 预设
    (meta.presets || []).forEach(function (pi) {
        if (keys.indexOf(pi.partKey) === -1) keys.push(pi.partKey);
    });

    // 所有角色
    (meta.charIndex || []).forEach(function (ci) {
        if (keys.indexOf(ci.partKey) === -1) keys.push(ci.partKey);
    });

    // activePartitions 里可能有的
    var ap = meta.activePartitions || {};
    for (var pk in ap) {
        if (keys.indexOf(pk) === -1) keys.push(pk);
    }

    var pending = keys.length;
    if (pending === 0) { cb(); return; }

    keys.forEach(function (pk) {
        if (partCache[pk]) { pending--; if (pending === 0) cb(); return; }
        idbGet(pk, function (raw) {
            partCache[pk] = ensurePartDefaults(raw);
            pending--;
            if (pending === 0) cb();
        });
    });
}

// ══════════════════════════════════════════════════════════
//  启动初始化
// ══════════════════════════════════════════════════════════

function loadFromLS() {
    try { var r = localStorage.getItem(LS_KEY); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
function removeLSData() { try { localStorage.removeItem(LS_KEY); } catch (e) {} }

function hasRealOutfitData(d) {
    if (!d || typeof d !== 'object') return false;
    if (Array.isArray(d.outfits) && d.outfits.length > 0) return true;
    if (d.chars && typeof d.chars === 'object') {
        for (var cn in d.chars) {
            var cd = d.chars[cn];
            if (cd && Array.isArray(cd.outfits) && cd.outfits.length > 0) return true;
        }
    }
    if (Array.isArray(d.presets)) {
        for (var i = 0; i < d.presets.length; i++) {
            var p = d.presets[i];
            if (p && Array.isArray(p.outfits) && p.outfits.length > 0) return true;
        }
    }
    return false;
}

export function initStorage(cb) {
    serverHydrated = false;
    serverInitFailed = false;
    lastInitializationError = null;
    serverPluginVersion = null;
    serverPluginUpdateRecommended = false;
    serverStorageState = null;
    serverRecoveryResult = null;
    serverSupportsPartitionTransactions = false;
    detectServer(function (result) {
        serverMode = !!result.installed;

        if (!result.ok) {
            failServerInitialization(
                '后端状态检测失败，请检查服务器后重试',
                result,
                cb,
                'SERVER_STATUS_FAILED'
            );
            return;
        }

        if (serverMode && serverSupportsPartitions) {
            if (serverStorageState && ['HEALTHY', 'NEW_INSTALL', 'META_MISSING', 'META_CORRUPT'].indexOf(serverStorageState) === -1) {
                failServerInitialization('后端返回了未知的数据健康状态，已停止初始化。', { storageState: serverStorageState }, cb, 'STORAGE_STATE_INVALID');
                return;
            }
            if (serverStorageState === 'META_MISSING' || serverStorageState === 'META_CORRUPT') {
                failServerInitialization(
                    serverStorageState === 'META_MISSING'
                        ? '检测到衣柜分包存在但 meta 索引缺失，且没有可信来源可自动恢复。'
                        : '后端 meta 索引损坏或与衣柜分包关系不合法。',
                    { storageState: serverStorageState, recoveryResult: serverRecoveryResult },
                    cb,
                    serverStorageState
                );
                return;
            }
            // v2 后端：只有完整 hydrate 成功才允许入口启动可写 UI
            initFromServerV2(function (err) { cb(err || null); });
            return;
        }

        if (serverMode) {
            // v1 后端：从后端拉取完整数据 → 拆成 meta + partitions 缓存到本地
            serverGetData(function (serverData) {
                if (hasRealOutfitData(serverData)) {
                    splitServerDataToPartitions(serverData, function () {
                        preloadAllPartitions(function () { cb(null); });
                    });
                    return;
                }
                // 后端无数据：检查本地
                initLocal(function () {
                    // 如果本地有数据，上传到后端
                    if (Object.keys(partCache).length > 0) {
                        scheduleServerPut();
                        try { console.log('[outfit-manager] 已将本地数据迁移到后端。'); } catch (e) {}
                    }
                    cb(null);
                });
            });
            return;
        }

        // 本地模式
        initLocal(function () { cb(null); });
    });
}

function clearServerWriteQueue() {
    if (partFlushTimer) clearTimeout(partFlushTimer);
    partFlushTimer = null;
    dirtyPartKeys = {};
}

function failServerInitialization(message, details, cb, code) {
    serverHydrated = false;
    serverInitFailed = true;
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = null;
    clearServerWriteQueue();
    var err = new Error(message);
    err.details = details || null;
    err.code = code || 'SERVER_INIT_FAILED';
    lastInitializationError = err;
    try { console.error('[outfit-manager] 后端初始化已中止：' + message, details || ''); } catch (e) {}
    cb(err);
}

function validateMetaPayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'meta 不是 JSON 对象';
    if (data._version !== 2) return 'meta._version 必须严格等于 2';
    var arrayFields = ['presets', 'charIndex', 'charFavorites'];
    for (var i = 0; i < arrayFields.length; i++) {
        var field = arrayFields[i];
        if (!Object.prototype.hasOwnProperty.call(data, field) || !Array.isArray(data[field])) return 'meta.' + field + ' 缺失或类型无效';
    }
    if (!data.activePartitions || typeof data.activePartitions !== 'object' || Array.isArray(data.activePartitions)) {
        return 'meta.activePartitions 缺失或类型无效';
    }
    if (!data.charGroups || typeof data.charGroups !== 'object' || Array.isArray(data.charGroups)) {
        return 'meta.charGroups 缺失或类型无效';
    }
    if (!Object.prototype.hasOwnProperty.call(data, 'activePresetId') || (data.activePresetId !== null && typeof data.activePresetId !== 'string')) return 'meta.activePresetId 类型无效';
    if (data.currentView !== 'user' && data.currentView !== 'char') return 'meta.currentView 类型无效';
    if (typeof data.currentChar !== 'string') return 'meta.currentChar 类型无效';
    if (data.mode !== undefined && ['text', 'image', 'both'].indexOf(data.mode) === -1) return 'meta.mode 类型无效';
    if (data.injectPosition !== undefined && ['user', 'system', 'context'].indexOf(data.injectPosition) === -1) return 'meta.injectPosition 类型无效';
    var stringSettings = ['singleTemplate', 'multiTemplate', 'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt', 'fabImage'];
    for (var settingIndex = 0; settingIndex < stringSettings.length; settingIndex++) {
        if (data[stringSettings[settingIndex]] !== undefined && typeof data[stringSettings[settingIndex]] !== 'string') return 'meta.' + stringSettings[settingIndex] + ' 类型无效';
    }
    if (data.debug !== undefined && typeof data.debug !== 'boolean') return 'meta.debug 类型无效';
    if (data.showBall !== undefined && typeof data.showBall !== 'boolean') return 'meta.showBall 类型无效';
    if (data.fabSize !== undefined && (typeof data.fabSize !== 'number' || !Number.isFinite(data.fabSize))) return 'meta.fabSize 类型无效';
    if (data.tagOrder !== undefined && (!Array.isArray(data.tagOrder) || data.tagOrder.some(function (item) { return typeof item !== 'string'; }))) return 'meta.tagOrder 类型无效';
    if (data.fabPos !== undefined && data.fabPos !== null && (!data.fabPos || typeof data.fabPos !== 'object' || Array.isArray(data.fabPos) ||
        typeof data.fabPos.top !== 'number' || !Number.isFinite(data.fabPos.top) || typeof data.fabPos.left !== 'number' || !Number.isFinite(data.fabPos.left))) return 'meta.fabPos 类型无效';
    if (data.apiVision !== undefined && (!data.apiVision || typeof data.apiVision !== 'object' || Array.isArray(data.apiVision))) return 'meta.apiVision 类型无效';
    if (data.apiVision && typeof data.apiVision === 'object' && !Array.isArray(data.apiVision)) {
        var visionStrings = ['endpoint', 'key', 'model', 'prompt', 'accPrompt'];
        for (var visionIndex = 0; visionIndex < visionStrings.length; visionIndex++) {
            if (data.apiVision[visionStrings[visionIndex]] !== undefined && typeof data.apiVision[visionStrings[visionIndex]] !== 'string') return 'meta.apiVision.' + visionStrings[visionIndex] + ' 类型无效';
        }
        if (data.apiVision.promptTemplates !== undefined && !Array.isArray(data.apiVision.promptTemplates)) return 'meta.apiVision.promptTemplates 类型无效';
        if (data.apiVision.activePromptTemplateId !== undefined && data.apiVision.activePromptTemplateId !== null && typeof data.apiVision.activePromptTemplateId !== 'string') return 'meta.apiVision.activePromptTemplateId 类型无效';
        if (data.apiVision.overwrite !== undefined && typeof data.apiVision.overwrite !== 'boolean') return 'meta.apiVision.overwrite 类型无效';
    }

    var presetIds = {};
    for (var j = 0; j < data.presets.length; j++) {
        var preset = data.presets[j];
        if (!preset || typeof preset.id !== 'string' || !preset.id || typeof preset.name !== 'string' || !preset.name ||
            preset.partKey !== 'user:' + preset.id || !isListedPartitionKey(preset.partKey) || presetIds[preset.id]) {
            return 'meta.presets 包含无效或重复索引';
        }
        presetIds[preset.id] = true;
    }
    if (typeof data.activePresetId === 'string' && !presetIds[data.activePresetId]) return 'meta.activePresetId 未引用现有预设';

    var charIds = {};
    var charNames = {};
    var sharedCount = 0;
    for (var n = 0; n < data.charIndex.length; n++) {
        var item = data.charIndex[n];
        if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || !item.name || !isListedPartitionKey(item.partKey)) return 'meta.charIndex 包含无效索引';
        if (item.id === SHARED_CHAR_KEY) {
            sharedCount++;
            if (item.name !== SHARED_CHAR_KEY || item.partKey !== 'char:__shared__') return 'meta.charIndex 的通用衣柜索引无效';
        } else if (!/^c_[A-Za-z0-9]{8}$/.test(item.id) || item.partKey !== 'char:' + item.id || item.name === SHARED_CHAR_KEY) {
            return 'meta.charIndex 包含无效角色索引';
        }
        if (charIds[item.id] || charNames[item.name]) return 'meta.charIndex 包含重复索引';
        charIds[item.id] = true;
        charNames[item.name] = true;
    }
    if (sharedCount > 1) return 'meta.charIndex 包含重复通用衣柜索引';
    if (data.currentChar && !charIds[data.currentChar]) return 'meta.currentChar 未引用现有角色';
    if (data.currentView === 'char' && (!data.currentChar || !charIds[data.currentChar])) return '角色视角未引用现有角色';
    for (var f = 0; f < data.charFavorites.length; f++) if (!charIds[data.charFavorites[f]] || data.charFavorites[f] === SHARED_CHAR_KEY) return 'meta.charFavorites 包含无效角色引用';
    for (var groupName in data.charGroups) {
        if (!Array.isArray(data.charGroups[groupName])) return 'meta.charGroups 包含无效分组';
        for (var g = 0; g < data.charGroups[groupName].length; g++) if (!charIds[data.charGroups[groupName][g]] || data.charGroups[groupName][g] === SHARED_CHAR_KEY) return 'meta.charGroups 包含无效角色引用';
    }
    var active = data.activePartitions || {};
    for (var key in active) {
        if (!isListedPartitionKey(key) || !Array.isArray(active[key]) || active[key].some(function (id) { return typeof id !== 'string'; })) return 'meta.activePartitions 包含无效分包引用';
    }
    return null;
}

function validatePartitionPayload(data, key) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return key + ' 不是 JSON 对象';
    var arrayFields = ['outfits', 'categories', 'activeIds', 'accessories', 'accCategories'];
    for (var i = 0; i < arrayFields.length; i++) {
        var field = arrayFields[i];
        if (!Object.prototype.hasOwnProperty.call(data, field) || !Array.isArray(data[field])) return key + '.' + field + ' 缺失或类型无效';
    }
    if (data.activeIds.some(function (id) { return typeof id !== 'string'; })) return key + '.activeIds 类型无效';
    if (new Set(data.activeIds).size !== data.activeIds.length) return key + '.activeIds 包含重复 id';
    for (var listIndex = 0; listIndex < 2; listIndex++) {
        var listName = listIndex === 0 ? 'outfits' : 'accessories';
        var ids = {};
        for (var n = 0; n < data[listName].length; n++) {
            var item = data[listName][n];
            if (!item || typeof item.id !== 'string' || !item.id || ids[item.id]) return key + '.' + listName + ' 包含无效或重复 id';
            ids[item.id] = true;
        }
    }
    var outfitIds = {};
    for (var outfitIndex = 0; outfitIndex < data.outfits.length; outfitIndex++) outfitIds[data.outfits[outfitIndex].id] = true;
    for (var activeIndex = 0; activeIndex < data.activeIds.length; activeIndex++) {
        if (!outfitIds[data.activeIds[activeIndex]]) return key + '.activeIds 引用了不存在的穿搭';
    }
    return null;
}

function collectRequiredPartKeys(meta) {
    var required = ['user:__default__'];
    function add(key) {
        if (typeof key === 'string' && required.indexOf(key) === -1) required.push(key);
    }
    (meta.presets || []).forEach(function (item) { if (item) add(item.partKey); });
    (meta.charIndex || []).forEach(function (item) { if (item) add(item.partKey); });
    var active = meta.activePartitions || {};
    for (var key in active) add(key);
    return required;
}

function validateHydratedRelations(meta, parts) {
    var expected = collectRequiredPartKeys(meta);
    var active = meta.activePartitions || {};
    var activeUserKey = meta.activePresetId ? 'user:' + meta.activePresetId : 'user:__default__';
    for (var i = 0; i < expected.length; i++) {
        var key = expected[i];
        var part = parts[key];
        if (!part) return 'meta 引用的衣柜分包缺失：' + key;
        var ids = part.activeIds || [];
        var tracked = Object.prototype.hasOwnProperty.call(active, key) ? active[key] : null;
        var shouldTrack = key.indexOf('char:') === 0 || key === activeUserKey;
        if (shouldTrack && ids.length > 0) {
            if (!tracked || tracked.length !== ids.length) return 'meta.activePartitions 与分包不一致：' + key;
            for (var n = 0; n < ids.length; n++) if (tracked[n] !== ids[n]) return 'meta.activePartitions 与分包不一致：' + key;
        }
        if ((!shouldTrack || ids.length === 0) && tracked && tracked.length > 0) return 'meta.activePartitions 包含不应激活的分包：' + key;
    }
    for (var activeKey in active) if (expected.indexOf(activeKey) === -1) return 'meta.activePartitions 引用了索引外分包：' + activeKey;
    return null;
}

function isListedPartitionKey(key) {
    return typeof key === 'string' && /^(user:(__default__|[A-Za-z0-9_-]+)|char:(__shared__|c_[A-Za-z0-9]{8}))$/.test(key);
}

function normalizeHydratedServerState() {
    var meta = loadMeta();
    collectRequiredPartKeys(meta).forEach(function (key) {
        if (!partCache[key]) savePartition(key, defPartition());
    });
}

// v2 后端启动：keys 成功后先加载 meta，再加载并验证全部现存 partition。
function initFromServerV2(cb) {
    serverGetPartitionKeys(function (keysResult) {
        if (!keysResult.ok) {
            failServerInitialization('后端分包索引读取失败，请刷新或检查服务器', keysResult, cb, 'PARTITION_KEYS_READ_FAILED');
            return;
        }
        var keys = keysResult.data;
        if (keys.length === 0) {
            // 只有成功读取到明确的空 keys，才可判定为全新后端并上传本地数据。
            initLocal(function () {
                serverHydrated = true;
                serverInitFailed = false;
                suppressServerWrites = true;
                try { normalizeHydratedServerState(); }
                finally { suppressServerWrites = false; }
                uploadLocalToServerV2(function (ok) {
                    if (!ok) {
                        failServerInitialization('初始化后端时有分包写入失败；本地数据仍保留，服务器写入已锁定。', null, cb, 'INITIAL_UPLOAD_FAILED');
                        return;
                    }
                    try { console.log('[outfit-manager] 已初始化空 v2 后端。'); } catch (e) {}
                    scheduleServerCheckpoint();
                    cb(null);
                });
            });
            return;
        }

        var seen = {};
        for (var i = 0; i < keys.length; i++) {
            if (typeof keys[i] !== 'string' || seen[keys[i]] || (keys[i] !== 'meta' && !isListedPartitionKey(keys[i]))) {
                failServerInitialization('后端返回了无效的分包索引', keysResult, cb, 'PARTITION_KEYS_INVALID');
                return;
            }
            seen[keys[i]] = true;
        }

        var partKeys = keys.filter(function (key) { return key !== 'meta'; });
        if (!seen.meta) {
            var orphanMessage = partKeys.length > 0
                ? '检测到衣柜分包存在但 meta 索引缺失，需要恢复索引。'
                : '后端 meta 索引缺失';
            failServerInitialization(orphanMessage, { keys: keys }, cb, 'META_MISSING');
            return;
        }

        serverGetPartition('meta', function (metaResult) {
            if (!metaResult.ok || !metaResult.found) {
                failServerInitialization('后端 meta 读取失败，请刷新或检查服务器', metaResult, cb, 'META_READ_FAILED');
                return;
            }
            var validationError = validateMetaPayload(metaResult.data);
            if (validationError) {
                failServerInitialization('后端 meta 数据无效：' + validationError, metaResult, cb, 'META_SCHEMA_INVALID');
                return;
            }

            var hydratedMeta;
            try { hydratedMeta = ensureMetaDefaults(metaResult.data); }
            catch (err) {
                failServerInitialization('后端 meta 数据规范化失败', { error: err && err.message }, cb, 'META_NORMALIZE_FAILED');
                return;
            }

            var requiredKeys = collectRequiredPartKeys(hydratedMeta);
            var missingKeys = requiredKeys.filter(function (key) { return !seen[key]; });
            if (missingKeys.length > 0) {
                failServerInitialization('meta 引用的衣柜分包缺失：' + missingKeys.join(', '), { keys: keys, missingKeys: missingKeys }, cb, 'PARTITION_MISSING');
                return;
            }

            var pending = partKeys.length;
            var failed = false;
            var hydratedParts = {};
            if (pending === 0) {
                failServerInitialization('后端已有 meta，但没有必要的衣柜分包', { keys: keys }, cb, 'PARTITIONS_EMPTY');
                return;
            }

            partKeys.forEach(function (key) {
                serverGetPartition(key, function (partResult) {
                    if (failed) return;
                    if (!partResult.ok || !partResult.found) {
                        failed = true;
                        failServerInitialization('后端衣柜分包读取失败：' + key, partResult, cb, 'PARTITION_READ_FAILED');
                        return;
                    }
                    var partValidationError = validatePartitionPayload(partResult.data, key);
                    if (partValidationError) {
                        failed = true;
                        failServerInitialization('后端衣柜分包数据无效：' + partValidationError, partResult, cb, 'PARTITION_SCHEMA_INVALID');
                        return;
                    }
                    try { hydratedParts[key] = ensurePartDefaults(partResult.data); }
                    catch (err) {
                        failed = true;
                        failServerInitialization('后端衣柜分包规范化失败：' + key, { error: err && err.message }, cb, 'PARTITION_NORMALIZE_FAILED');
                        return;
                    }
                    pending--;
                    if (pending === 0) {
                        var relationError = validateHydratedRelations(hydratedMeta, hydratedParts);
                        if (relationError) {
                            failed = true;
                            failServerInitialization('后端 meta 引用关系无效：' + relationError, { keys: keys }, cb, 'META_CORRUPT');
                            return;
                        }
                        // 所有读取完成前不触碰现有缓存；此处才原子切换 hydrate 结果。
                        metaCache = hydratedMeta;
                        partCache = hydratedParts;
                        deletedPartKeys = {};
                        var entries = [{ key: 'meta', value: metaCache }];
                        partKeys.forEach(function (partKey) {
                            entries.push({ key: partKey, value: partCache[partKey] });
                        });
                        idbPutBatch(entries, function () {
                            serverHydrated = true;
                            serverInitFailed = false;
                            normalizeHydratedServerState();
                            scheduleServerCheckpoint();
                            cb(null);
                        });
                    }
                });
            });
        });
    });
}

// 本地数据上传到 v2 后端（本地→server 迁移）
function uploadLocalToServerV2(cb) {
    // 新后端走显式 meta+partitions 事务；旧 v2 后端保持兼容，并至少确保 meta 最后提交。
    if (serverSupportsPartitionTransactions) serverPutPartitionDataset(cb);
    else uploadLocalPartitionsSequentially(cb);
}

function uploadLocalPartitionsSequentially(cb) {
    var meta = metaCache || defMeta();
    var keys = collectRequiredPartKeys(meta).concat(['meta']);
    var index = 0;
    function next(ok) {
        if (ok === false) { cb(false); return; }
        if (index >= keys.length) { cb(true); return; }
        var key = keys[index++];
        var value = key === 'meta' ? metaCache : partCache[key];
        if (!value) { cb(false); return; }
        serverPutPartition(key, value, next);
    }
    next(true);
}

function initLocal(cb) {
    // 检查是否已有 v2 meta
    idbGet('meta', function (existingMeta) {
        if (existingMeta && existingMeta._version >= 2) {
            // 已是 v2 分包格式
            metaCache = ensureMetaDefaults(existingMeta);
            preloadAllPartitions(function () { cb(); });
            return;
        }

        // 检查旧 v1 key
        idbGet(LEGACY_DATA_KEY, function (oldData) {
            if (oldData && hasRealOutfitData(oldData)) {
                // v1 → v2 迁移
                migrateFromV1(oldData, function () {
                    preloadAllPartitions(function () { cb(); });
                });
                return;
            }

            // 检查 localStorage（极旧版本）
            var lsData = loadFromLS();
            if (lsData && hasRealOutfitData(lsData)) {
                migrateFromV1(lsData, function () {
                    removeLSData();
                    preloadAllPartitions(function () { cb(); });
                });
                return;
            }

            // 全新安装：创建空 meta + 空默认 partition
            metaCache = defMeta();
            partCache['user:__default__'] = defPartition();
            idbPutBatch([
                { key: 'meta', value: metaCache },
                { key: 'user:__default__', value: partCache['user:__default__'] }
            ], function () { cb(); });
        });
    });
}

// ══════════════════════════════════════════════════════════
//  兼容旧接口（过渡期，逐步废弃）
//  旧 UI 模块大量使用 d.chars / d.charNames / d.charFavorites /
//  d.charGroups / d.presets / d.currentChar（角色名），
//  必须在 load() 里完整组装这些字段，在 save() 里把修改反写回
//  meta + partitions，包括角色名 ↔ charId 的双向翻译。
// ══════════════════════════════════════════════════════════

// charId ↔ name 翻译辅助（仅兼容层内部使用）
function _nameToIdMap() {
    var meta = loadMeta();
    var map = {};
    (meta.charIndex || []).forEach(function (ci) { if (ci.id !== SHARED_CHAR_KEY) map[ci.name] = ci.id; });
    return map;
}
function _idToNameMap() {
    var meta = loadMeta();
    var map = {};
    (meta.charIndex || []).forEach(function (ci) { if (ci.id !== SHARED_CHAR_KEY) map[ci.id] = ci.name; });
    return map;
}

// load() — 旧代码的读取入口（deprecated，适配完成后删除）
// 返回完整旧格式对象，chars 按角色名索引，currentChar 是角色名
export function load() {
    var meta = loadMeta();
    var part = loadCurrent();

    var d = {};
    // meta 设置字段
    var metaKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'fabPos', 'tagOrder',
        'currentView', 'activePresetId'
    ];
    metaKeys.forEach(function (k) { d[k] = meta[k]; });

    // currentChar: charId → 角色名（旧 UI 使用角色名）
    if (meta.currentChar === SHARED_CHAR_KEY) {
        d.currentChar = SHARED_CHAR_KEY;
    } else if (meta.currentChar) {
        d.currentChar = charNameById(meta.currentChar) || '';
    } else {
        d.currentChar = '';
    }

    // 当前视角 partition
    d.outfits = part.outfits;
    d.categories = part.categories;
    d.activeIds = part.activeIds;
    d.accessories = part.accessories;
    d.accCategories = part.accCategories;

    // 组装 chars：{ 角色名: { outfits, categories, activeIds, accessories, accCategories } }
    d.chars = {};
    d.charNames = [];
    (meta.charIndex || []).forEach(function (ci) {
        var cp = partCache[ci.partKey] || defPartition();
        if (ci.id === SHARED_CHAR_KEY) {
            d.chars[SHARED_CHAR_KEY] = { outfits: cp.outfits, categories: cp.categories, activeIds: cp.activeIds, accessories: cp.accessories, accCategories: cp.accCategories };
        } else {
            d.charNames.push(ci.name);
            d.chars[ci.name] = { outfits: cp.outfits, categories: cp.categories, activeIds: cp.activeIds, accessories: cp.accessories, accCategories: cp.accCategories };
        }
    });

    // charFavorites: charId[] → name[]
    d.charFavorites = [];
    var idToName = _idToNameMap();
    (meta.charFavorites || []).forEach(function (cid) {
        if (idToName[cid]) d.charFavorites.push(idToName[cid]);
    });

    // charGroups: { groupName: charId[] } → { groupName: name[] }
    d.charGroups = {};
    for (var gn in (meta.charGroups || {})) {
        d.charGroups[gn] = [];
        (meta.charGroups[gn] || []).forEach(function (cid) {
            if (idToName[cid]) d.charGroups[gn].push(idToName[cid]);
        });
    }

    // presets（旧格式包含内嵌 outfits，但兼容层只做索引展示）
    d.presets = [];
    (meta.presets || []).forEach(function (pi) {
        var pp = partCache[pi.partKey] || null;
        d.presets.push({
            id: pi.id,
            name: pi.name,
            outfits: pp ? pp.outfits : [],
            categories: pp ? pp.categories : [],
            activeIds: pp ? pp.activeIds : [],
            accessories: pp ? pp.accessories : [],
            accCategories: pp ? pp.accCategories : []
        });
    });

    return d;
}

// save(d) — 旧代码的保存入口（deprecated，适配完成后删除）
// 把旧格式对象拆回 meta + partitions
// 处理：角色增删改名、currentChar 名→id、收藏/分组名→id、
//       chars 数据回写到各 partition、activePartitions 同步
export function save(d) {
    var meta = loadMeta();

    // ── 1. meta 设置字段 ──
    var settingsKeys = [
        'mode', 'injectPosition', 'singleTemplate', 'multiTemplate',
        'charSingleTemplate', 'charMultiTemplate', 'imagePrompt', 'multiImagePrompt',
        'debug', 'apiVision', 'showBall', 'fabImage', 'fabSize', 'fabPos', 'tagOrder',
        'currentView', 'activePresetId'
    ];
    settingsKeys.forEach(function (k) { if (d[k] !== undefined) meta[k] = d[k]; });

    // ── 2. 当前视角 partition ──
    var part = loadCurrent();
    part.outfits = d.outfits || part.outfits;
    part.categories = d.categories || part.categories;
    part.activeIds = d.activeIds || part.activeIds;
    if (d.accessories) part.accessories = d.accessories;
    if (d.accCategories) part.accCategories = d.accCategories;
    saveCurrent(part);
    syncActivePartitions(currentPartKey(), part.activeIds);

    // ── 3. currentChar: 延迟到 charIndex 重建之后处理 ──
    // （旧 UI 的 d.currentChar 是角色名，可能是刚改过的新名）
    // （必须等第4步 charIndex 更新完才能正确翻译 name → id）
    var pendingCurrentChar = d.currentChar; // 暂存，后面处理

    // ── 4. 角色增删改名同步 ──
    // 对比 d.charNames 和 meta.charIndex 来检测变化
    var dNames = [];
    (d.charNames || []).forEach(function (name) {
        if (!name || name === SHARED_CHAR_KEY || dNames.indexOf(name) !== -1) return;
        dNames.push(name);
    });
    var oldIndex = meta.charIndex || [];
    var oldNameSet = {};
    oldIndex.forEach(function (ci) { if (ci.id !== SHARED_CHAR_KEY) oldNameSet[ci.name] = ci; });

    var newIndex = [];
    // 保留通用衣柜
    oldIndex.forEach(function (ci) { if (ci.id === SHARED_CHAR_KEY) newIndex.push(ci); });
    if (newIndex.length === 0) {
        var sharedPartKey = 'char:__shared__';
        if (!partCache[sharedPartKey]) savePartition(sharedPartKey, defPartition());
        newIndex.push({ id: SHARED_CHAR_KEY, name: SHARED_CHAR_KEY, partKey: sharedPartKey });
    }

    dNames.forEach(function (name) {
        if (oldNameSet[name]) {
            // 已存在，保留
            newIndex.push(oldNameSet[name]);
            delete oldNameSet[name];
        } else {
            // 新角色：检查是否是改名（旧名消失+新名出现+chars有数据）
            // 改名在旧 UI 里是直接 dd.chars[newName] = dd.chars[oldName]; delete dd.chars[oldName];
            // 然后 dd.charNames[idx] = newName; 所以 oldNameSet 里会剩下旧名
            // 我们检查 d.chars[name] 是否有引用到某个旧 partition 的数据
            var foundRename = null;
            var foundOldName = '';
            for (var oldName in oldNameSet) {
                var oldCi = oldNameSet[oldName];
                var oldPart = partCache[oldCi.partKey];
                if (oldPart && d.chars && d.chars[name] && d.chars[name].outfits === oldPart.outfits) {
                    // 浅引用相同，说明是改名
                    foundRename = oldCi;
                    foundOldName = oldName;
                    break;
                }
            }
            if (foundRename) {
                // 改名：更新 charIndex 里的 name，partition key 不变
                foundRename.name = name;
                newIndex.push(foundRename);
                delete oldNameSet[foundOldName];
            } else {
                // 全新角色
                var newCid = 'c_' + genId8();
                var newPartKey = 'char:' + newCid;
                newIndex.push({ id: newCid, name: name, partKey: newPartKey });
                // 如果 d.chars[name] 有数据，写入新 partition
                if (d.chars && d.chars[name]) {
                    var newPart = {
                        outfits: d.chars[name].outfits || [],
                        categories: d.chars[name].categories || [],
                        activeIds: d.chars[name].activeIds || [],
                        accessories: d.chars[name].accessories || [],
                        accCategories: d.chars[name].accCategories || []
                    };
                    savePartition(newPartKey, newPart);
                    if (newPart.activeIds.length > 0) {
                        syncActivePartitions(newPartKey, newPart.activeIds);
                    }
                } else {
                    savePartition(newPartKey, defPartition());
                }
                // 如果是新增角色且设为当前角色，更新 meta.currentChar
                if (d.currentChar === name) meta.currentChar = newCid;
            }
        }
    });

    // oldNameSet 里剩下的 = 被删除的角色
    for (var deletedName in oldNameSet) {
        var deletedCi = oldNameSet[deletedName];
        deletePartition(deletedCi.partKey);
        // 清理 activePartitions
        if (meta.activePartitions) delete meta.activePartitions[deletedCi.partKey];
        // 清理 favorites
        if (meta.charFavorites) {
            var fi = meta.charFavorites.indexOf(deletedCi.id);
            if (fi !== -1) meta.charFavorites.splice(fi, 1);
        }
        // 清理 groups
        if (meta.charGroups) {
            for (var gg in meta.charGroups) {
                var gi = meta.charGroups[gg].indexOf(deletedCi.id);
                if (gi !== -1) meta.charGroups[gg].splice(gi, 1);
            }
        }
    }

    meta.charIndex = newIndex;

    // ── 4b. currentChar: 现在 charIndex 已重建，可以安全翻译 name → id ──
    if (pendingCurrentChar === SHARED_CHAR_KEY) {
        meta.currentChar = SHARED_CHAR_KEY;
    } else if (pendingCurrentChar) {
        // charIdByName 读的是 meta.charIndex（刚更新过），包含改名后的记录
        var resolvedCid = charIdByName(pendingCurrentChar);
        meta.currentChar = resolvedCid || (meta.currentView === 'char' ? SHARED_CHAR_KEY : '');
    } else {
        meta.currentChar = meta.currentView === 'char' ? SHARED_CHAR_KEY : '';
    }

    // ── 5. chars 数据回写到各 partition ──
    // 安全守卫：只回写 load() 组装时有对应缓存的 partition
    // 如果某个 partition 没在 partCache 里（理论上兼容期不会发生，
    // 因为 preloadAllPartitions 会加载全部），跳过而不是写空
    if (d.chars) {
        var nameToId = _nameToIdMap();
        for (var cn in d.chars) {
            var cid2, pk;
            if (cn === SHARED_CHAR_KEY) {
                pk = 'char:__shared__';
            } else {
                cid2 = nameToId[cn];
                if (!cid2) {
                    // 可能是上面刚新增的，重建映射
                    cid2 = charIdByName(cn);
                }
                if (!cid2) continue; // 安全跳过
                pk = 'char:' + cid2;
            }
            // 守卫：如果 partition 从未加载过，不要写入空数据
            if (!partCache[pk] && (!d.chars[cn].outfits || d.chars[cn].outfits.length === 0)) {
                continue; // 跳过，保护磁盘上的数据
            }
            var charPart = loadPartition(pk);
            charPart.outfits = d.chars[cn].outfits || charPart.outfits;
            charPart.categories = d.chars[cn].categories || charPart.categories;
            charPart.activeIds = d.chars[cn].activeIds || charPart.activeIds;
            if (d.chars[cn].accessories) charPart.accessories = d.chars[cn].accessories;
            if (d.chars[cn].accCategories) charPart.accCategories = d.chars[cn].accCategories;
            savePartition(pk, charPart);
            syncActivePartitions(pk, charPart.activeIds);
        }
    }

    // ── 6. charFavorites: name[] → charId[] ──
    if (d.charFavorites) {
        var nameToId2 = _nameToIdMap();
        meta.charFavorites = [];
        d.charFavorites.forEach(function (name) {
            if (nameToId2[name]) meta.charFavorites.push(nameToId2[name]);
        });
    }

    // ── 7. charGroups: { groupName: name[] } → { groupName: charId[] } ──
    if (d.charGroups) {
        var nameToId3 = _nameToIdMap();
        meta.charGroups = {};
        for (var gn2 in d.charGroups) {
            meta.charGroups[gn2] = [];
            (d.charGroups[gn2] || []).forEach(function (name) {
                if (nameToId3[name]) meta.charGroups[gn2].push(nameToId3[name]);
            });
        }
    }

    // ── 8. presets 同步：d.presets → meta.presets + user:{id} partition ──
    // 旧 UI 里 d.presets 是 [{id, name, outfits, categories, activeIds}, ...]
    if (d.presets) {
        var oldPresets = meta.presets || [];
        var oldPresetMap = {};
        oldPresets.forEach(function (p) { oldPresetMap[p.id] = p; });

        var newPresets = [];
        d.presets.forEach(function (dp) {
            if (!dp || !dp.id) return;
            var existing = oldPresetMap[dp.id];
            if (existing) {
                // 已有预设：可能改名或数据更新
                existing.name = dp.name || existing.name;
                newPresets.push(existing);
                // 写 partition 数据
                var pp = {
                    outfits: dp.outfits || [],
                    categories: dp.categories || [],
                    activeIds: dp.activeIds || [],
                    accessories: dp.accessories || [],
                    accCategories: dp.accCategories || []
                };
                savePartition(existing.partKey, pp);
                delete oldPresetMap[dp.id];
            } else {
                // 新预设
                var pid = dp.id;
                var partKey = 'user:' + pid;
                newPresets.push({ id: pid, name: dp.name || '未命名', partKey: partKey });
                var newPP = {
                    outfits: dp.outfits || [],
                    categories: dp.categories || [],
                    activeIds: dp.activeIds || [],
                    accessories: dp.accessories || [],
                    accCategories: dp.accCategories || []
                };
                savePartition(partKey, newPP);
            }
        });

        // oldPresetMap 里剩下的 = 被删除的预设
        for (var dpid in oldPresetMap) {
            var deletedPreset = oldPresetMap[dpid];
            deletePartition(deletedPreset.partKey);
            if (meta.activePartitions) delete meta.activePartitions[deletedPreset.partKey];
            // 如果删的是当前活跃预设，回退到默认
            if (meta.activePresetId === dpid) meta.activePresetId = null;
        }

        meta.presets = newPresets;

        // activePresetId 同步
        if (d.activePresetId !== undefined) meta.activePresetId = d.activePresetId;

        // 清理 User activePartitions：只保留当前活跃的 user:*
        var curUPK = currentUserPartKey();
        cleanUserActivePartitions(meta, curUPK);
        var curUPart = loadPartition(curUPK);
        if (curUPart.activeIds && curUPart.activeIds.length > 0) {
            meta.activePartitions[curUPK] = curUPart.activeIds.slice();
        }
    }

    // ── 9. 保存 meta ──
    saveMeta(meta);
}
