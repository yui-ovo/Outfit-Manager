import { currentPartKey, loadPartition, loadMeta, savePartition, syncActivePartitions } from './db.js';
import { sceneEntry, configureScene, removeScenePool, changeSceneOutfit, sceneOutfitText, sceneSupported, sceneStatus, categoryItems } from './scene-wardrobe.js';
import { esc, toast } from './utils.js';
import { state, fn } from './bridge.js';

export function openSceneMenu(pool) {
    const key = currentPartKey(), part = loadPartition(key);
    const entry = sceneEntry(key);
    const label = pool.category ? pool.category + (pool.subCategory ? ' / ' + pool.subCategory : '') : '全部';
    const count = categoryItems(part, pool.category, pool.subCategory).length;
    const sheet = fn.createSheet('<div class="om-sheet-title">🎲 ' + esc(label) + ' · ' + count + ' 套</div>' +
        '<div class="om-hint">长按分类或右键可打开此菜单。副 API 负责判断换装和筛选，主 API 只接收当前穿搭文字。请先为衣服填写描述。</div>' +
        '<div class="om-hint" style="margin:10px 0">' + (sceneSupported() ? '副 API 自动换装已开启；发送消息时先判断，有需要才换衣。' : '请在设置中启用并配置“场景换装副 API”。现在也可手动随机换装。') + '</div>' +
        (sceneStatus() ? '<div class="om-hint" style="margin:10px 0">' + esc(sceneStatus()) + '</div>' : '') +
        (entry && entry.enabled ? '<div class="om-hint" style="white-space:pre-wrap;margin:10px 0">本聊天随机范围：' + esc(entry.pools.map(p => p.category ? p.category + (p.subCategory ? ' / ' + p.subCategory : '') : '全部').join('、')) + '\n' + esc(sceneOutfitText(part, entry.current)) + '</div>' : '') +
        '<button class="om-modal-btn" data-action="add">加入场景随机衣柜（不立即换衣）</button>' +
        '<button class="om-modal-btn" data-action="draw">现在从本类随机换一套</button>' +
        '<button class="om-modal-btn" data-action="all">全选本类（普通衣柜模式）</button>' +
        '<button class="om-modal-btn" data-action="settings">设置换装副 API</button>' +
        (entry && entry.enabled ? '<button class="om-modal-btn" data-action="remove">从随机范围移除本类</button><button class="om-modal-btn" data-action="off">退出场景模式，恢复原勾选</button>' : '') +
        '<button class="om-modal-cancel" data-action="close">关闭</button>');
    sheet.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', async () => {
        if (button.dataset.action === 'close') { fn.closeSheet(sheet); return; }
        if (button.dataset.action === 'settings') { fn.closeSheet(sheet); fn.openSettingsSheet(); return; }
        sheet.querySelectorAll('button').forEach(b => { b.disabled = true; });
        try {
            const action = button.dataset.action;
            if ((action === 'draw' || action === 'add' || action === 'all') && !count) throw new Error('这个分类暂无穿搭');
            if (action === 'add' || action === 'draw') {
                await configureScene(key, pool);
                if (action === 'draw') await changeSceneOutfit({ owner: key, category: pool.subCategory || pool.category || '全部', pool }, true);
            } else if (action === 'remove') await removeScenePool(key, pool);
            else if (action === 'off') await configureScene(key, null, false);
            else if (action === 'all') {
                if (entry && entry.enabled) await configureScene(key, null, false);
                const selected = new Set(part.activeIds || []);
                categoryItems(part, pool.category, pool.subCategory).forEach(o => selected.add(o.id));
                part.activeIds = [...selected];
                if (key.startsWith('char:')) {
                    const otherKeys = key === 'char:__shared__'
                        ? (loadMeta().charIndex || []).map(c => c.partKey).filter(k => k !== key)
                        : ['char:__shared__'];
                    otherKeys.forEach(k => {
                        const other = loadPartition(k);
                        if (other.activeIds && other.activeIds.length) {
                            other.activeIds = []; savePartition(k, other); syncActivePartitions(k, []);
                        }
                    });
                }
                savePartition(key, part); syncActivePartitions(key, part.activeIds);
                if (fn.updateBtn) fn.updateBtn();
            }
            fn.closeSheet(sheet);
            fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus();
            toast(action === 'draw' ? '已随机换装；当前穿着会在本聊天中保持' : '已更新衣柜选择');
        } catch (e) { toast(e.message, true); sheet.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
    }));
}

export function bindSceneCategories(bar) {
    bar.querySelectorAll('.om-catbtn[data-c],.om-catbtn[data-sub]').forEach(button => {
        const pool = button.dataset.c !== undefined
            ? { category: button.dataset.c === '__all__' ? '' : button.dataset.c, subCategory: '' }
            : { category: state.catDrillParent, subCategory: button.dataset.sub === '__all__' ? '' : button.dataset.sub };
        let timer = null, start = null, consumed = false;
        function cancel() { if (timer) clearTimeout(timer); timer = null; }
        button.addEventListener('pointerdown', e => {
            if (e.button !== 0) return;
            cancel(); consumed = false; start = [e.clientX, e.clientY];
            timer = setTimeout(() => { timer = null; consumed = true; openSceneMenu(pool); }, 550);
        });
        button.addEventListener('pointermove', e => { if (start && Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 10) cancel(); });
        ['pointerup', 'pointercancel', 'pointerleave'].forEach(event => button.addEventListener(event, cancel));
        button.addEventListener('click', e => { if (consumed) { e.preventDefault(); e.stopImmediatePropagation(); consumed = false; } }, true);
        button.addEventListener('contextmenu', e => { e.preventDefault(); cancel(); if (!consumed) openSceneMenu(pool); consumed = true; });
    });
    const manage = document.createElement('button');
    manage.className = 'om-catbtn';
    const entry = sceneEntry(currentPartKey());
    manage.textContent = entry && entry.enabled ? '🎲 场景衣柜已开启' : '🎲 场景衣柜';
    manage.addEventListener('click', () => openSceneMenu({ category: state.catDrillParent || (state.curCat === '__all__' ? '' : state.curCat), subCategory: state.curSubCat || '' }));
    bar.appendChild(manage);
}
