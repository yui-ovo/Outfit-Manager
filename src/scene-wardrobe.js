import { loadPartition, loadMeta, currentUserPartKey, charNameById } from './db.js';
import { partGetById, partOutfitNumbers, getActiveKit, getKitAccessories, SHARED_CHAR_KEY } from './data.js';
import { fn } from './bridge.js';

const KEY = 'outfit_manager_scene_v1';
const TOOL = 'outfit_manager_change';
let registered = false;
let changeQueue = Promise.resolve();

function context() {
    try { return SillyTavern.getContext(); } catch (e) { return null; }
}
function session(required) {
    const ctx = context();
    if (!ctx || !ctx.chatMetadata || typeof ctx.saveMetadata !== 'function' ||
        (ctx.characterId === undefined && !ctx.groupId)) {
        if (required) throw new Error('请先打开一个聊天，再设置场景衣柜');
        return null;
    }
    return ctx;
}
function store(ctx) { return ctx.chatMetadata[KEY] || {}; }
export function sceneEntry(key) {
    const ctx = session(false);
    return ctx && store(ctx)[key] || null;
}
export function sceneSupported() {
    const ctx = context();
    return !!(registered && ctx && typeof ctx.isToolCallingSupported === 'function' && ctx.isToolCallingSupported());
}
function refresh() {
    ['renderCatbar', 'renderGrid', 'renderBottomStatus'].forEach(name => { try { if (fn[name]) fn[name](); } catch (e) { console.warn(e); } });
}
async function commit(ctx, key, value) {
    if (context().chatMetadata !== ctx.chatMetadata) throw new Error('聊天已切换，请在当前聊天重试');
    const previous = ctx.chatMetadata[KEY];
    ctx.chatMetadata[KEY] = Object.assign({}, previous, { [key]: value });
    try { await ctx.saveMetadata(); }
    catch (e) { ctx.chatMetadata[KEY] = previous; throw new Error('聊天穿着状态保存失败，请重试'); }
    if (context().chatMetadata === ctx.chatMetadata) refresh();
}
export function categoryItems(part, category, subCategory) {
    return (part.outfits || []).filter(o => (!category || o.category === category) && (!subCategory || o.subCategory === subCategory));
}
function poolKey(pool) { return JSON.stringify([pool.category || '', pool.subCategory || '']); }
function poolLabel(pool) { return pool.category ? pool.category + (pool.subCategory ? ' / ' + pool.subCategory : '') : '全部'; }
function available(entry, part) {
    const ids = new Set();
    (entry.pools || []).forEach(pool => categoryItems(part, pool.category, pool.subCategory).forEach(o => ids.add(o.id)));
    return (part.outfits || []).filter(o => ids.has(o.id));
}
export async function configureScene(key, pool, enabled = true) {
    const ctx = session(true);
    const old = store(ctx)[key];
    const part = loadPartition(key);
    const next = Object.assign({ pools: [], current: null }, old, { enabled });
    next.pools = (next.pools || []).slice();
    if (pool && !next.pools.some(p => poolKey(p) === poolKey(pool))) next.pools.push(pool);
    if (!old || !old.enabled) {
        const selected = (part.activeIds || []).map(id => partGetById(part, id)).filter(Boolean);
        next.current = selected.length === 1 ? { type: 'saved', id: selected[0].id } : null;
        next.decisions = null;
    }
    await commit(ctx, key, next);
    return next;
}
export async function removeScenePool(key, pool) {
    const ctx = session(true), old = store(ctx)[key];
    if (!old) return;
    const pools = old.pools.filter(p => poolKey(p) !== poolKey(pool));
    await commit(ctx, key, Object.assign({}, old, { pools, enabled: pools.length > 0 }));
}
export function sceneOutfitText(part, current) {
    if (!current) return '尚未设置当前穿着；沿用聊天正文中的穿着，只有实际换装时才调用工具。';
    if (current.type === 'temporary') return '临时日常穿搭（未加入收藏）：' + current.description;
    const o = partGetById(part, current.id);
    if (!o) return '原穿搭已删除；沿用最新剧情，换装时重新选择。';
    let text = '[穿搭' + partOutfitNumbers(part)[o.id] + '] 名称：' + (o.name || '未命名') + '\n' + (o.description || '暂无文字描述，不要猜测图片细节。');
    const kit = getActiveKit(o);
    if (kit) getKitAccessories(part, kit).filter(a => !(kit.disabledAccIds || []).includes(a.id)).forEach(a => {
        if (a.description) text += '\n[' + (a.category || '单品') + '] ' + a.description;
    });
    return text;
}
export function sceneOwners() {
    const ctx = session(false);
    if (!ctx) return [];
    const entries = store(ctx), meta = loadMeta();
    const user = currentUserPartKey();
    const shared = 'char:' + SHARED_CHAR_KEY;
    const hasShared = entries[shared] && entries[shared].enabled;
    return Object.keys(entries).filter(key => {
        if (!entries[key] || !entries[key].enabled) return false;
        if (key.startsWith('user:')) return key === user;
        if (key === shared) return !!ctx.name2;
        return key.startsWith('char:') && !hasShared && (meta.charIndex || []).some(c => c.partKey === key);
    }).map(key => ({ key, entry: entries[key], part: loadPartition(key),
        name: key === user ? 'User' : key === shared ? ctx.name2 : charNameById(key.slice(5)) }));
}

export function scenePrompt() {
    const owners = sceneOwners();
    if (!owners.length) return '';
    const instructions = sceneSupported()
        ? '剧情确实发生换装或用户明确要求换装时，先调用 outfit_manager_change，拿到结果后再描写换装。不要预先编写抽取结果。用户指定名称/编号优先；否则选择合适分类让插件随机。无合适服装时通过工具登记普通日常服装的简短描述。'
        : '当前接口未启用自动换装工具。由用户在插件中手动随机换装；不要声称已自动抽取。剧情自然换装且无合适衣服时可按正文补充普通日常服装，已发生的换装以最新正文为准。';
    return '[场景衣柜：以下替代普通勾选穿搭注入；仅发送当前穿着和候选目录]\n' + instructions +
        '\n保持穿着连续，仅改变地点、谈论计划或未来打算不构成换装。可以在同一次回复里按实际换装顺序调用工具。最新工具结果优先于先前穿着；不要每轮重新随机。按叙事需要提及服装，无需每条回复描写。\n' +
        owners.map(({ key, name, entry, part }) => {
            const items = available(entry, part);
            const categories = [...new Set(items.map(o => o.category || '未分类'))];
            return '[' + name + '；owner=' + key + ']\n当前记录：' + sceneOutfitText(part, entry.current) +
                '\n可抽取分类：' + (categories.map(c => {
                    const group = items.filter(o => (o.category || '未分类') === c);
                    const hints = [...new Set(group.flatMap(o => [o.subCategory, o.sceneTag]).filter(Boolean))].join('、').slice(0, 120);
                    return c + '（' + group.length + '套' + (hints ? '；子分类/场景：' + hints : '') + '）';
                }).join('、') || '无') +
                '\n可用名称与编号通过工具按用户原话匹配，不需要发送所有描述。';
        }).join('\n\n');
}

function turnKey(ctx) {
    const chat = ctx.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i].is_user) return JSON.stringify([i, chat[i].mes]);
    return 'initial';
}

export function changeSceneOutfit(args, manual = false) {
    const origin = session(true).chatMetadata;
    const task = changeQueue.then(() => {
        if (session(true).chatMetadata !== origin) throw new Error('聊天已切换，本次换装已取消');
        return performChange(args, manual);
    });
    changeQueue = task.catch(() => {});
    return task;
}

async function performChange(args, manual) {
    const ctx = session(true);
    const owner = sceneOwners().find(o => o.key === args.owner);
    if (!owner) throw new Error('此衣柜未启用场景模式');
    const { key, entry, part } = owner;
    const candidates = available(entry, part);
    const selector = (args.selector || '').trim();
    const category = (args.category || '').trim();
    const actionKey = JSON.stringify([selector, category]);
    const turn = turnKey(ctx);
    const decisions = entry.decisions && entry.decisions.turn === turn ? entry.decisions.choices : {};
    if (!manual && Object.hasOwn(decisions, actionKey)) {
        const current = decisions[actionKey];
        // A retried/duplicate call returns the same draw, also on regenerated replies.
        await commit(ctx, key, Object.assign({}, entry, { current }));
        return sceneOutfitText(part, current);
    }
    let current;
    const numbers = partOutfitNumbers(part);
    let choices;
    if (selector) {
        // Explicit names/numbers can address the full enabled wardrobe, not only its pools.
        const number = /^穿搭\s*(\d+)$/.exec(selector);
        choices = (part.outfits || []).filter(o => number ? numbers[o.id] === Number(number[1]) : o.name === selector);
        if (!choices.length && !number) choices = (part.outfits || []).filter(o => o.name && o.name.includes(selector));
        if (choices.length !== 1) return '未换装：名称或编号未找到或不唯一，请向用户澄清。';
    } else {
        if (!category) return '未换装：请指定本次需要的服装分类。';
        choices = candidates.filter(o => category === '全部' || o.category === category || o.subCategory === category || o.sceneTag === category || (category === '未分类' && !o.category));
        if (manual && args.pool) {
            const ids = new Set(categoryItems(part, args.pool.category, args.pool.subCategory).map(o => o.id));
            choices = choices.filter(o => ids.has(o.id));
        }
    }
    if (choices.length) {
        const alternatives = choices.filter(o => !entry.current || o.id !== entry.current.id);
        const pool = alternatives.length ? alternatives : choices;
        const o = pool[Math.floor(Math.random() * pool.length)];
        current = { type: 'saved', id: o.id };
    } else {
        if (manual) throw new Error('这个分类没有可抽取的穿搭');
        // A saved item outside the selected pools is not silently replaced by an invented one.
        if ((part.outfits || []).some(o => o.category === category || o.subCategory === category || o.sceneTag === category)) return '未换装：此分类存在，但未加入随机衣柜，请用户将它加入或明确指定名称/编号。';
        const description = (args.fallback_description || '').trim();
        if (!description || description.length > 500) return '未换装：没有合适衣服，请用 fallback_description 提交不超过500字的合理日常服装描述。';
        current = { type: 'temporary', description, category };
    }
    const choicesForTurn = Object.assign({}, decisions, { [actionKey]: current });
    await commit(ctx, key, Object.assign({}, entry, { current, decisions: { turn, choices: choicesForTurn } }));
    return '换装已登记。请以此结果继续本次剧情，不要改成其他衣服：\n' + sceneOutfitText(part, current);
}

export function registerSceneTools() {
    if (registered) return;
    const ctx = context();
    if (!ctx || typeof ctx.registerFunctionTool !== 'function') return;
    ctx.registerFunctionTool({
        name: TOOL, displayName: '场景换装',
        description: '仅在当前剧情实际换装或用户明确要求时调用。保持穿着连续，不为地点变化、未来计划、否定换装调用。指定名称或编号优先；否则按分类随机。缺少类别时登记普通临时服装。必须等工具返回，再描写穿着。',
        parameters: { type: 'object', properties: {
            owner: { type: 'string', description: '场景衣柜提供的 owner 值，区分User和角色' },
            category: { type: 'string', description: '本次实际换装的分类，例如睡衣；应与候选目录匹配' },
            selector: { type: 'string', description: '用户明确指定的穿搭名称或穿搭N；未指定时留空' },
            fallback_description: { type: 'string', description: '仅当衣柜无合适类别时，补充普通日常服装的简短描述；不会保存进收藏' }
        }, required: ['owner', 'category'], additionalProperties: false },
        action: async args => { try { return await changeSceneOutfit(args); } catch (e) { return '未换装：' + e.message; } },
        shouldRegister: () => sceneOwners().length > 0,
        formatMessage: () => '正在选择本次换装…', stealth: false
    });
    registered = true;
}
