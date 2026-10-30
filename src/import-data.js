import { loadMeta, loadPartition, currentUserPartKey, saveImportPartition, isServerMode, uploadImage, getImageUrlPrefix } from './db.js';
import { defPartition, SHARED_CHAR_KEY } from './data.js';
import { genId } from './utils.js';
import { checkImportCancelled, yieldImport } from './import-json.js';

function isObject(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function cloneItem(item) {
    // Copy metadata, sharing immutable image strings instead of stringify/parse.
    if (Array.isArray(item)) return item.map(cloneItem);
    if (!isObject(item)) return item;
    var copy = {};
    Object.keys(item).forEach(function (key) {
        Object.defineProperty(copy, key, { value: cloneItem(item[key]), enumerable: true, configurable: true, writable: true });
    });
    return copy;
}

export function importJobs(data) {
    if (!isObject(data)) throw new Error('请选择穿搭管理器导出的 JSON 对象');
    var jobs = [];
    function add(kind, name, source) {
        if (!isObject(source)) throw new Error('衣柜数据格式无效');
        ['outfits', 'accessories', 'categories', 'accCategories', 'activeIds'].forEach(function (key) {
            if (source[key] !== undefined && !Array.isArray(source[key])) throw new Error(key + ' 必须是列表');
        });
        ['outfits', 'accessories'].forEach(function (key) {
            (source[key] || []).forEach(function (item) {
                if (!isObject(item) || (item.name !== undefined && typeof item.name !== 'string') ||
                    (item.imageData !== undefined && item.imageData !== null && typeof item.imageData !== 'string')) throw new Error('穿搭或单品格式无效');
                if (item.kits !== undefined && !Array.isArray(item.kits)) throw new Error('套装格式无效');
                (item.kits || []).forEach(function (kit) {
                    if (!isObject(kit) || (kit.accIds !== undefined && !Array.isArray(kit.accIds)) ||
                        (kit.disabledAccIds !== undefined && !Array.isArray(kit.disabledAccIds))) throw new Error('套装单品引用格式无效');
                });
            });
        });
        ['categories', 'accCategories'].forEach(function (key) {
            (source[key] || []).forEach(function (cat) {
                if (typeof cat !== 'string' && (!isObject(cat) || typeof cat.name !== 'string' ||
                    (cat.children !== undefined && !Array.isArray(cat.children)))) throw new Error('分类格式无效');
            });
        });
        jobs.push({ kind: kind, name: name, source: source });
    }
    if (data.type === 'char') {
        if (typeof data.charName !== 'string' || !data.charName.trim()) throw new Error('角色名称缺失');
        add('char', data.charName, data);
    } else if (data.type === 'preset') {
        add('preset', data.preset && data.preset.name || '未命名', data.preset);
    } else {
        if (data.type && data.type !== 'user' && data.type !== 'chars_all') throw new Error('不支持此导入文件类型');
        if (data.type !== 'chars_all') {
            if (!Array.isArray(data.outfits) && !Array.isArray(data.accessories)) throw new Error('文件中没有穿搭或单品列表');
            add('user', 'User', data);
        }
        if (data.chars !== undefined && !isObject(data.chars)) throw new Error('角色衣柜格式无效');
        Object.keys(data.chars || {}).forEach(function (name) { add('char', name, data.chars[name]); });
        if (data.presets !== undefined && !Array.isArray(data.presets)) throw new Error('预设列表格式无效');
        (data.presets || []).forEach(function (preset) { add('preset', preset && preset.name || '未命名', preset); });
    }
    if (!jobs.length) throw new Error('文件中没有可导入的衣柜');
    if (data._assets !== undefined && !isObject(data._assets)) throw new Error('图片资源格式无效');
    return jobs;
}

function mergeCategories(existing, incoming) {
    var result = existing.slice();
    var names = new Set(result.map(function (cat) { return typeof cat === 'string' ? cat : cat.name; }));
    incoming.forEach(function (cat) {
        var name = typeof cat === 'string' ? cat : cat.name;
        if (!names.has(name)) { result.push(cloneItem(cat)); names.add(name); }
    });
    return result;
}

export async function mergeImportPartition(existing, source, mode, options) {
    options = options || {};
    var part = mode === 'replace' ? defPartition() : Object.assign({}, existing, {
        outfits: (existing.outfits || []).slice(), accessories: (existing.accessories || []).slice(),
        categories: (existing.categories || []).slice(), accCategories: (existing.accCategories || []).slice(),
        activeIds: (existing.activeIds || []).slice()
    });
    var accMap = new Map(), outfitMap = new Map(), processed = 0;
    var total = (source.accessories || []).length + (source.outfits || []).length;
    for (var field of ['accessories', 'outfits']) {
        var incoming = source[field] || [], target = part[field];
        var ids = new Set(target.map(function (item) { return item.id; }));
        var byName = new Map();
        function nameKey(item) { return field === 'accessories' ? JSON.stringify([item.name, item.category || '']) : item.name; }
        target.forEach(function (item, index) { if (item.name && !byName.has(nameKey(item))) byName.set(nameKey(item), index); });
        for (var i = 0; i < incoming.length; i++) {
            checkImportCancelled(options.signal);
            var item = cloneItem(incoming[i]);
            var found = mode === 'update' && item.name ? byName.get(nameKey(item)) : undefined;
            var oldId = item.id;
            if (found !== undefined) item.id = target[found].id;
            else {
                var candidate = field === 'accessories' && oldId && !ids.has(oldId) ? oldId : genId();
                while (ids.has(candidate)) candidate = genId();
                item.id = candidate; ids.add(candidate);
            }
            if (field === 'accessories' && oldId) accMap.set(oldId, item.id);
            if (field === 'outfits' && oldId) outfitMap.set(oldId, item.id);
            if (field === 'outfits') (item.kits || []).forEach(function (kit) {
                ['accIds', 'disabledAccIds'].forEach(function (key) {
                    if (kit[key]) kit[key] = kit[key].map(function (id) { return accMap.get(id) || id; });
                });
            });
            if (options.resolveImage && item.imageData) item.imageData = await options.resolveImage(item.imageData);
            if (found !== undefined) target[found] = Object.assign({}, target[found], item);
            else { if (item.name && !byName.has(nameKey(item))) byName.set(nameKey(item), target.length); target.push(item); }
            processed++;
            if (processed % 20 === 0 || processed === total) {
                if (options.onProgress) options.onProgress(processed, total);
                await yieldImport();
            }
        }
    }
    part.categories = mergeCategories(part.categories, source.categories || []);
    part.accCategories = mergeCategories(part.accCategories, source.accCategories || []);
    if (options.preserveActive) part.activeIds = (source.activeIds || []).map(function (id) { return outfitMap.get(id); }).filter(Boolean);
    checkImportCancelled(options.signal);
    return part;
}

export async function importWardrobes(data, mode, options) {
    options = options || {};
    if (['merge', 'update', 'replace'].indexOf(mode) === -1) throw new Error('无效的导入方式');
    var jobs = importJobs(data); // Validate every wardrobe before the first write.
    var userKey = options.userKey || currentUserPartKey();
    var completed = 0;
    var assets = data._assets || {}, resolvedAssets = new Map();
    var prefix = getImageUrlPrefix();
    async function resolveImage(url) {
        checkImportCancelled(options.signal);
        var assetName = typeof url === 'string' && url.indexOf(prefix) === 0 ? url.slice(prefix.length) : null;
        if (assetName !== null && resolvedAssets.has(assetName)) return resolvedAssets.get(assetName);
        var value = assetName !== null && Object.hasOwn(assets, assetName) ? assets[assetName] : url;
        if (typeof value !== 'string') throw new Error('图片资源格式无效');
        if (isServerMode() && value.indexOf('data:image/') === 0) {
            value = await new Promise(function (resolve, reject) {
                uploadImage(value, function (err, result) { if (err) reject(new Error(String(err))); else resolve(result); });
            });
            // uploadImage historically falls back to base64. Do not accumulate
            // silently on a failed upload during a large import.
            if (!value || value.indexOf(prefix) !== 0) throw new Error('图片上传失败，请检查后端连接后重试');
        }
        if (assetName !== null) resolvedAssets.set(assetName, value);
        return value;
    }
    try {
        for (var job of jobs) {
            checkImportCancelled(options.signal);
            var meta = loadMeta(), entry = null, key = userKey;
            if (job.kind === 'char') {
                entry = (meta.charIndex || []).find(function (item) { return item.name === job.name || (job.name === SHARED_CHAR_KEY && item.id === SHARED_CHAR_KEY); });
                if (!entry) {
                    var cid = job.name === SHARED_CHAR_KEY ? SHARED_CHAR_KEY : 'c_' + genId();
                    entry = { id: cid, name: job.name, partKey: 'char:' + cid };
                }
                key = entry.partKey;
            } else if (job.kind === 'preset') {
                var pid = genId();
                entry = { id: pid, name: job.name, partKey: 'user:' + pid };
                key = entry.partKey;
            }
            var part = await mergeImportPartition(loadPartition(key), job.source, job.kind === 'preset' ? 'replace' : mode, {
                signal: options.signal, resolveImage: resolveImage, preserveActive: job.kind === 'preset',
                onProgress: function (done, total) {
                    if (options.onProgress) options.onProgress({ phase: 'items', name: job.name, done: done, total: total, completed: completed });
                }
            });
            checkImportCancelled(options.signal);
            if (options.onProgress) options.onProgress({ phase: 'saving', name: job.name, completed: completed });
            await saveImportPartition(key, part, entry && { kind: job.kind, entry: entry });
            completed++;
            if (options.onProgress) options.onProgress({ phase: 'saved', name: job.name, completed: completed });
            // Source objects and target share image strings, never JSON copies.
            await yieldImport();
        }
    } catch (error) { error.completedWardrobes = completed; throw error; }
    return { completedWardrobes: completed };
}
