import { partGetById } from './data.js';

export function sceneMode(meta) {
    return meta.apiScene && meta.apiScene.mode || (meta.apiScene && meta.apiScene.enabled ? 'api' : 'candidates');
}
export function candidateHash(value) {
    const text = JSON.stringify(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < text.length; i++) {
        a = Math.imul(a ^ text.charCodeAt(i), 16777619);
        b = Math.imul(b, 33) ^ text.charCodeAt(i);
    }
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}
export function candidatePrefix(chat, index) {
    return candidateHash([index, chat.slice(Math.max(0, index - 3), index).map(m => [m.is_user, m.mes])]);
}
export function candidateGroups(part, pools) {
    const groups = new Map();
    for (const outfit of part.outfits || []) {
        if (!(pools || []).some(p => (!p.category || p.category === outfit.category) && (!p.subCategory || p.subCategory === outfit.subCategory))) continue;
        const key = outfit.category || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(outfit);
    }
    return groups;
}
// Persist IDs and opaque tokens, not images or duplicate descriptions. A category
// with several selected subcategories still contributes only one candidate.
export function candidateOffers(part, entry, reroll = false) {
    const groups = candidateGroups(part, entry.pools), old = entry.candidates || [];
    return [...groups].map(([category, items]) => {
        const previous = old.find(c => c.category === category);
        if (!reroll && previous && items.some(o => o.id === previous.id)) return previous;
        let choices = items.filter(o => o.id !== (entry.current && entry.current.id) && (!reroll || !previous || o.id !== previous.id));
        if (!choices.length) choices = items.filter(o => !reroll || !previous || o.id !== previous.id);
        if (!choices.length) choices = items;
        const outfit = choices[Math.floor(Math.random() * choices.length)];
        const token = 'c' + candidateHash([outfit.id, Date.now(), Math.random()]);
        return { category, id: outfit.id, token };
    });
}
export function stripCandidateMarkers(text) {
    if (typeof text !== 'string') return text;
    const cleaned = text.replace(/<!--\s*om-outfit:[\s\S]*?-->/g, '');
    return cleaned === text ? text : cleaned.trimEnd();
}
export function readCandidateMarkers(text) {
    // Never execute output. Ignore examples inside fenced code; accept only
    // single-line JSON comments with a bounded size and count.
    const content = String(text || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
    const blocks = [...content.matchAll(/<!--\s*om-outfit:([^\r\n]*?)-->/g)];
    if (blocks.length > 16) throw new Error('换装标记过多，未自动登记');
    return blocks.map(match => {
        if (match[1].length > 2000) throw new Error('换装标记过长');
        let value;
        try { value = JSON.parse(match[1]); } catch (e) { throw new Error('换装标记格式错误'); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.owner !== 'string' || value.owner.length > 100) throw new Error('换装标记的人物无效');
        if (typeof value.candidate === 'string' && value.candidate.length < 100 && value.temporary === undefined) return value;
        if (typeof value.temporary === 'string' && value.temporary.trim() && value.temporary.length <= 240 && value.candidate === undefined) return value;
        throw new Error('换装标记的穿搭无效');
    });
}
export function resolveCandidateMarker(marker, ticket, part) {
    if (marker.temporary !== undefined) return { type: 'temporary', description: marker.temporary.trim() };
    const offer = ticket.offers.find(o => o.token === marker.candidate);
    if (!offer || !partGetById(part, offer.id)) throw new Error('候选已失效或未提供给本次回复，未自动登记');
    return { type: 'saved', id: offer.id };
}

export function candidatePrompt(owners, describe) {
    if (!owners.length) return '';
    const sections = owners.map(({ key, name, entry, part }) => {
        const ticket = entry.candidateTicket;
        const current = ticket ? ticket.before : entry.current;
        const offers = ticket ? ticket.offers : entry.candidates || [];
        return '[' + name + '；owner=' + key + ']\n当前穿着：' + describe(part, current) + '\n换装候选（不是已经穿上）：\n' +
            (offers.map(c => '分类：' + (c.category || '未分类') + '；candidate=' + c.token + '\n' +
                describe(part, { type: 'saved', id: c.id }).slice(0, 380)).join('\n') || '无');
    });
    return '[分类候选衣柜]\n' + sections.join('\n\n') + '\n' +
        '保持穿着连续；只有明确要求或正文确实发生换装时才选候选。换地点、未来计划、假设或否定不等于换装。不必每轮描写衣服。\n' +
        '若确实换装，按候选细节写正文，并在回复末尾另起一行输出一个单行HTML注释：<!--om-outfit:{"owner":"对应owner","candidate":"选中的candidate"}-->。未换装不要输出标记。不要代码块，不要解释标记。\n' +
        '候选不合适或缺少类别时，可补充合理日常穿着，输出<!--om-outfit:{"owner":"对应owner","temporary":"实际新穿着，240字以内"}-->。衣柜不是全部衣物，睡觉无需被迫穿常服。每个人物最多一个标记，记录本轮结束时的实际穿着；不可编造候选编号。';
}
