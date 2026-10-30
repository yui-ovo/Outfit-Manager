// ── 穿搭管理器 · 注入核心 v2 ────────────────────────────────
// fetch/XHR 拦截 + 穿搭信息注入到 AI 请求
// v2: 使用 loadMeta() + loadActivePartitions() 代替旧 load() 全量读取

import { loadMeta, loadActivePartitions, currentUserPartKey, charNameById } from './db.js';
import { SHARED_CHAR_KEY, partGetById, partOutfitNumbers, getActiveKit, getKitAccessories } from './data.js';
import { toast } from './utils.js';
import { state } from './bridge.js';

var BAIBAOKU_SAVE_GENERATE_PATH = '/api/plugins/baibaoku/v1/chats/save-generate';
var RECENT_INJECTED_BODY_TTL = 2 * 60 * 1000;
var recentInjectedBodies = [];
var OUTFIT_SELECTION_RULE = '用户明确指定穿搭名称或编号（如“穿搭2”）时，优先选择该穿搭；名称可用能唯一对应的简称。仅在用户未指定时按场景标签选择。编号仅在各自衣柜内有效；名称或编号有歧义时先询问，不要猜测。';

function outfitLabel(outfit, numbers) {
    return '[穿搭' + numbers[outfit.id] + '] 名称：' + ((outfit.name || '').trim() || '未命名穿搭');
}

// 获取注入用的图片URL（server模式下优先用预解析的base64）
function getInjectImageUrl(outfit) {
    if (!outfit || !outfit.imageData) return null;
    // 检查预解析缓存
    if (state.resolvedImages && state.resolvedImages[outfit.id]) {
        var cached = state.resolvedImages[outfit.id];
        if (cached.dataUrl && cached.url === outfit.imageData) {
            return cached.dataUrl;
        }
    }
    return outfit.imageData;
}

// ── 文本注入 ─────────────────────────────────────────────
// position: 'system' | 'context' | 'user'
function injectText(p, text, position) {
    if (!p.messages || !Array.isArray(p.messages)) {
        if (typeof p.prompt === 'string') p.prompt = text + '\n\n' + p.prompt;
        return;
    }

    if (position === 'user') {
        for (var j = p.messages.length - 1; j >= 0; j--) {
            if (p.messages[j].role === 'user') {
                var c = p.messages[j].content;
                if (typeof c === 'string') p.messages[j].content = c + '\n\n' + text;
                else if (Array.isArray(c)) c.push({ type: 'text', text: '\n\n' + text });
                break;
            }
        }
    } else if (position === 'context') {
        var lastUserIdx = -1;
        for (var k = p.messages.length - 1; k >= 0; k--) {
            if (p.messages[k].role === 'user') { lastUserIdx = k; break; }
        }
        var sysMsg = { role: 'system', content: text };
        if (lastUserIdx > 0) p.messages.splice(lastUserIdx, 0, sysMsg);
        else if (lastUserIdx === 0) p.messages.unshift(sysMsg);
        else p.messages.push(sysMsg);
    } else {
        var si = -1; for (var i = 0; i < p.messages.length; i++) { if (p.messages[i].role === 'system') { si = i; break; } }
        if (si !== -1) {
            var sm = p.messages[si];
            if (typeof sm.content === 'string') sm.content += '\n\n' + text;
            else if (Array.isArray(sm.content)) sm.content.push({ type: 'text', text: '\n\n' + text });
        } else { p.messages.unshift({ role: 'system', content: text }); }
    }
}

// ── 图片注入（旧接口，保留兼容）─────────────────────────
function injectImages(p, imgs) {
    if (!p.messages || !Array.isArray(p.messages)) return;
    for (var j = p.messages.length - 1; j >= 0; j--) {
        if (p.messages[j].role === 'user') {
            var c = p.messages[j].content;
            var blocks = imgs.map(function (img) { return { type: 'image_url', image_url: { url: img } }; });
            if (typeof c === 'string') p.messages[j].content = [{ type: 'text', text: c }].concat(blocks);
            else if (Array.isArray(c)) blocks.forEach(function (b) { c.push(b); });
            break;
        }
    }
}

// ── 按owner交错注入 文字标签+图片 ────────────────────────
function injectImageBlocks(p, ownerImageGroups, imgPrompt, multiImgPrompt) {
    if (!p.messages || !Array.isArray(p.messages)) return;
    for (var j = p.messages.length - 1; j >= 0; j--) {
        if (p.messages[j].role === 'user') {
            var c = p.messages[j].content;
            if (typeof c === 'string') {
                c = [{ type: 'text', text: c }];
                p.messages[j].content = c;
            }

            if (ownerImageGroups.length > 1) {
                c.push({ type: 'text', text: '\n\n=== 穿搭图片参考 ===' });
            }

            var hasMulti = false;
            ownerImageGroups.forEach(function (grp) {
                if (grp.isMulti) {
                    hasMulti = true;
                    c.push({ type: 'text', text: '\n[' + grp.name + '的可选穿搭 - 共' + grp.outfits.length + '套]' });
                    grp.outfits.forEach(function (o) {
                        c.push({ type: 'text', text: '\n' + outfitLabel(o, grp.numbers) + (o.sceneTag ? ' [场景：' + o.sceneTag + ']' : '') + '\n参考图片：' });
                        c.push({ type: 'image_url', image_url: { url: getInjectImageUrl(o) } });
                    });
                } else {
                    var o = grp.outfits[0];
                    c.push({ type: 'text', text: '\n[' + grp.name + '当前穿着]\n' + outfitLabel(o, grp.numbers) });
                    c.push({ type: 'image_url', image_url: { url: getInjectImageUrl(o) } });
                }
            });

            var prompt = hasMulti ? multiImgPrompt : imgPrompt;
            if (prompt) {
                c.push({ type: 'text', text: '\n' + prompt });
            }
            if (hasMulti) c.push({ type: 'text', text: '\n' + OUTFIT_SELECTION_RULE });

            if (ownerImageGroups.length > 1) {
                c.push({ type: 'text', text: '\n=== 穿搭图片结束 ===' });
            }
            break;
        }
    }
}

// ── 请求体注入逻辑（v2：基于 meta + activePartitions）──
function markPayloadInjected(p) {
    try {
        Object.defineProperty(p, '__omInjected', { value: true, configurable: true });
    } catch (e) {}
}

function cleanupRecentInjectedBodies(now) {
    var t = now || Date.now();
    recentInjectedBodies = recentInjectedBodies.filter(function (item) {
        return item && (t - item.at) < RECENT_INJECTED_BODY_TTL;
    });
}

function rememberInjectedBody(p) {
    try {
        cleanupRecentInjectedBodies();
        recentInjectedBodies.push({ body: JSON.stringify(p), at: Date.now() });
        if (recentInjectedBodies.length > 20) recentInjectedBodies.shift();
    } catch (e) {}
}

function wasRecentlyInjectedBody(bodyStr) {
    cleanupRecentInjectedBodies();
    for (var i = 0; i < recentInjectedBodies.length; i++) {
        if (recentInjectedBodies[i].body === bodyStr) return true;
    }
    return false;
}

function getFetchUrl(input) {
    try {
        if (typeof input === 'string') return input;
        if (input instanceof URL) return input.href;
        if (input && typeof input.url === 'string') return input.url;
    } catch (e) {}
    return '';
}

function isBaibaokuSaveGenerateRequest(input) {
    try {
        var rawUrl = getFetchUrl(input);
        if (!rawUrl) return false;
        var url = new URL(rawUrl, location.href);
        return url.origin === location.origin && url.pathname === BAIBAOKU_SAVE_GENERATE_PATH;
    } catch (e) {
        return false;
    }
}

function tryInjectPayload(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (p.__omInjected) return false;
    if (!p.messages && p.prompt === undefined) return false;

    var meta = loadMeta();
    var pos = meta.injectPosition || 'user';
    var useImg = (meta.mode === 'image' || meta.mode === 'both');
    var useText = (meta.mode === 'text' || meta.mode === 'both');

    // 获取所有有激活穿搭的 partition（已预加载，同步读取）
    var activeParts = loadActivePartitions();
    // activeParts = { 'user:p_xxx': {outfits,categories,activeIds}, 'char:c_xxx': {...}, ... }

    if (Object.keys(activeParts).length === 0) return null;

    // 收集所有 owner 及其激活穿搭
    var owners = [];

    // ── User 穿搭 ──
    var curUserPK = currentUserPartKey();
    if (activeParts[curUserPK]) {
        var userPart = activeParts[curUserPK];
        var userOutfits = [];
        (userPart.activeIds || []).forEach(function (id) {
            var o = partGetById(userPart, id);
            if (o) userOutfits.push(o);
        });
        if (userOutfits.length > 0) {
            owners.push({
                name: 'User',
                outfits: userOutfits,
                partition: userPart,
                tplSingle: meta.singleTemplate,
                tplMulti: meta.multiTemplate
            });
        }
    }

    // ── 角色衣柜：通用 vs 单人互斥 ──
    var sharedOutfits = [];
    var sharedPartKey = 'char:' + SHARED_CHAR_KEY;
    if (activeParts[sharedPartKey]) {
        var sharedPart = activeParts[sharedPartKey];
        (sharedPart.activeIds || []).forEach(function (id) {
            var o = partGetById(sharedPart, id);
            if (o) sharedOutfits.push(o);
        });
    }

    if (sharedOutfits.length > 0) {
        // 通用衣柜有激活 → 用当前角色卡名字注入，忽略所有单人衣柜
        var charName2 = '';
        try { charName2 = SillyTavern.getContext().name2 || ''; } catch (e) {}
        if (charName2) {
            owners.push({
                name: charName2,
                outfits: sharedOutfits,
                partition: activeParts[sharedPartKey],
                tplSingle: meta.charSingleTemplate,
                tplMulti: meta.charMultiTemplate
            });
        }
    } else {
        // 通用衣柜无激活 → 遍历各角色 partition
        for (var pk in activeParts) {
            // 跳过 user:* 和 shared
            if (pk.indexOf('char:') !== 0) continue;
            if (pk === sharedPartKey) continue;

            var charPart = activeParts[pk];
            var charOutfits = [];
            (charPart.activeIds || []).forEach(function (id) {
                var o = partGetById(charPart, id);
                if (o) charOutfits.push(o);
            });
            if (charOutfits.length > 0) {
                // 从 partKey 提取 charId，查角色名
                var charId = pk.substring(5); // 'char:'.length = 5
                var ownerName = charNameById(charId) || charId;
                owners.push({
                    name: ownerName,
                    outfits: charOutfits,
                    partition: charPart,
                    tplSingle: meta.charSingleTemplate,
                    tplMulti: meta.charMultiTemplate
                });
            }
        }
    }

    if (owners.length === 0) return null;

    // ── 组装注入内容（v2 + 单品支持）──
    var allTextParts = [];
    var ownerImageGroups = [];

    // 单品描述拼接辅助：按单品 category 排序后拼接
    function buildAccText(partition, outfit) {
        var kit = getActiveKit(outfit);
        if (!kit) return '';
        var accs = getKitAccessories(partition, kit);
        var disabled = Array.isArray(kit.disabledAccIds) ? kit.disabledAccIds : [];
        if (disabled.length > 0) {
            accs = accs.filter(function (acc) { return disabled.indexOf(acc.id) === -1; });
        }
        if (accs.length === 0) return '';
        // 按 category 字母排序保证注入顺序固定
        accs.sort(function (a, b) {
            var ca = (a.category || '').toLowerCase();
            var cb = (b.category || '').toLowerCase();
            if (ca < cb) return -1;
            if (ca > cb) return 1;
            return 0;
        });
        var lines = accs.map(function (acc) {
            var label = acc.category ? acc.category : '单品';
            var desc = (acc.description && acc.description.trim()) ? acc.description.trim() : '';
            return desc ? '[' + label + '] ' + desc : '';
        }).filter(function (l) { return l !== ''; });
        return lines.length > 0 ? '\n' + lines.join('\n') : '';
    }

    owners.forEach(function (ow) {
        var active = ow.outfits;
        var isMulti = active.length > 1;
        var numbers = partOutfitNumbers(ow.partition);

        if (isMulti) {
            var lines = active.map(function (o) {
                var scene = o.sceneTag ? '【场景：' + o.sceneTag + '】' : '';
                var desc = (o.description && o.description.trim()) ? o.description.trim() : '';
                var accText = buildAccText(ow.partition, o);
                return outfitLabel(o, numbers) + (scene ? '\n' + scene : '') + (desc ? '\n' + desc : '') + accText;
            });
            if (useText) {
                var wt = (ow.tplMulti || '[服装信息]\n{{charName}}的穿搭：\n{{wardrobe}}')
                    .replace(/\{\{charName\}\}/g, ow.name)
                    .replace('{{wardrobe}}', lines.join('\n\n'));
                allTextParts.push(wt + '\n' + OUTFIT_SELECTION_RULE);
            }
            if (useImg) {
                var imgOutfits = active.filter(function (o) { return !!o.imageData; });
                if (imgOutfits.length > 0) ownerImageGroups.push({ name: ow.name, outfits: imgOutfits, numbers: numbers, isMulti: true });
            }
        } else {
            var o = active[0];
            if (useText) {
                var desc2 = (o.description && o.description.trim()) ? o.description.trim() : '';
                var accText2 = buildAccText(ow.partition, o);
                var fullDesc = outfitLabel(o, numbers) + (desc2 ? '\n' + desc2 : '') + accText2;
                var st = (ow.tplSingle || '[服装信息]\n{{charName}}当前穿着：\n{{description}}')
                    .replace(/\{\{charName\}\}/g, ow.name)
                    .replace('{{description}}', fullDesc);
                allTextParts.push(st);
            }
            if (useImg && o.imageData) { ownerImageGroups.push({ name: ow.name, outfits: [o], numbers: numbers, isMulti: false }); }
        }
    });

    var injected = false;

    if (allTextParts.length > 0) {
        var mergedText;
        if (allTextParts.length === 1) {
            mergedText = allTextParts[0];
        } else {
            mergedText = '=== 当前场景服装信息（必须严格遵守，不可自行编造服装）===\n\n' + allTextParts.join('\n\n---\n\n') + '\n\n=== 服装信息结束 ===';
        }
        injectText(p, mergedText, pos);
        injected = true;
    }

    if (ownerImageGroups.length > 0) {
        var imgPrompt = meta.imagePrompt || '';
        var multiImgPrompt = meta.multiImagePrompt || '';
        injectImageBlocks(p, ownerImageGroups, imgPrompt, multiImgPrompt);
        injected = true;
    }

    if (meta.debug) {
        var summary = owners.map(function (ow) { return ow.name + ':' + ow.outfits.length + '套'; }).join(' + ');
        toast('👗 ' + summary + ' [' + meta.mode + '|' + pos + ']');
    }

    if (injected) markPayloadInjected(p);
    return injected;
}

function tryInjectBody(bodyStr, options) {
    if (wasRecentlyInjectedBody(bodyStr)) return null;

    var p; try { p = JSON.parse(bodyStr); } catch (e) { return null; }
    if (tryInjectPayload(p)) return JSON.stringify(p);

    if (options && options.baibaokuSaveGenerate && p && p.generate && typeof p.generate === 'object') {
        var nestedBody = '';
        try { nestedBody = JSON.stringify(p.generate); } catch (e) {}
        if (nestedBody && wasRecentlyInjectedBody(nestedBody)) return null;
        if (tryInjectPayload(p.generate)) return JSON.stringify(p);
    }

    return null;
}

function registerCompletionEventInjection() {
    if (window.__omCompletionEventInjectionInstalled) return;
    window.__omCompletionEventInjectionInstalled = true;

    import('/script.js').then(function (mod) {
        var eventSource = mod && mod.eventSource;
        var eventTypes = mod && mod.event_types;
        var eventName = eventTypes && eventTypes.CHAT_COMPLETION_SETTINGS_READY;
        if (!eventSource || !eventName || typeof eventSource.on !== 'function') return;

        var handler = function (payload) {
            try {
                if (tryInjectPayload(payload)) rememberInjectedBody(payload);
            } catch (e) {}
        };

        eventSource.on(eventName, handler);
        if (typeof eventSource.makeFirst === 'function') {
            eventSource.makeFirst(eventName, handler);
        }
    }).catch(function () {
        window.__omCompletionEventInjectionInstalled = false;
    });
}

// ── 安装拦截器 ─────────────────────────────────────────
export function setupInjection() {
    // 防止重复安装（热重载等场景）
    if (window.__omInjectionInstalled) return;
    window.__omInjectionInstalled = true;

    registerCompletionEventInjection();

    var origFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            // 跳过插件内部的 API 调用
            if (init && init.headers && init.headers['X-OM-Internal']) {
                return origFetch.apply(this, arguments);
            }
            if (init && init.body && typeof init.body === 'string') {
                var nb = tryInjectBody(init.body, { baibaokuSaveGenerate: isBaibaokuSaveGenerateRequest(input) });
                if (nb) { init = Object.assign({}, init, { body: nb }); return origFetch.call(this, input, init); }
            }
        } catch (e) {}
        return origFetch.apply(this, arguments);
    };
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        try { if (body && typeof body === 'string') { var nb = tryInjectBody(body); if (nb) return origSend.call(this, nb); } } catch (e) {}
        return origSend.apply(this, arguments);
    };
}
