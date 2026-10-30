// ── 穿搭管理器 · 主界面 v2 ──────────────────────────────────
// 全屏弹窗、视角切换、分类栏、穿搭网格、底栏状态、详情面板
// v2: 使用分包存储 API (loadMeta/loadCurrent/saveCurrent/etc.)
//     角色管理仍经由兼容层 load()/save() 处理 charIndex ↔ charNames 翻译

import {
    load, save,
    loadMeta, saveMeta,
    loadCurrent,
    charNameById
} from './db.js';
import {
    SHARED_CHAR_KEY, SHARED_CHAR_LABEL,
    renameCharGroup, deleteCharGroup
} from './data.js';
import { esc, toast } from './utils.js';
import { injectStyles } from './styles.js';
import { state, fn } from './bridge.js';
import { OM_VERSION } from './version.js';
import {
    preResolveActiveImages as preResolveOutfitActiveImages,
    resetOutfitsUiState, disconnectOutfitGridObserver,
    renderCatbar as renderOutfitCatbar,
    renderOutfitGrid,
    renderBottomStatus as renderOutfitBottomStatus,
    buildDetailGroups as buildOutfitDetailGroups,
    refreshDetailPanel as refreshOutfitDetailPanel,
    toggleDetailPanel as toggleOutfitDetailPanel,
    openDetailPanel as openOutfitDetailPanel,
    closeDetailPanel as closeOutfitDetailPanel
} from './ui-outfits.js';
import {
    clearKitDraft as clearAccessoryKitDraft,
    isCurrentKitFocus as isCurrentAccessoryKitFocus,
    setKitFocus as setAccessoryKitFocus,
    ensureKitFocusForAccMode as ensureAccessoryKitFocusForAccMode,
    draftHasAcc as accessoryDraftHasAcc,
    toggleDraftAcc as toggleAccessoryDraftAcc,
    saveFocusedKitDraft as saveAccessoryFocusedKitDraft,
    toggleDisabledAcc as toggleAccessoryDisabledAcc,
    renderAccCatbar as renderAccessoryCatbar,
    renderAccGrid as renderAccessoryGrid
} from './ui-accessories.js';

function preResolveActiveImages() {
    return preResolveOutfitActiveImages();
}

var SCRIPT_NAME = '穿搭管理';

function clearKitDraft() {
    return clearAccessoryKitDraft();
}

function isCurrentKitFocus(partKey, outfitId) {
    return isCurrentAccessoryKitFocus(partKey, outfitId);
}

function setKitFocus(partKey, outfitId) {
    return setAccessoryKitFocus(partKey, outfitId);
}

function ensureKitFocusForAccMode(showToast) {
    return ensureAccessoryKitFocusForAccMode(showToast);
}

function draftHasAcc(accId) {
    return accessoryDraftHasAcc(accId);
}

function refreshDetailPanel() {
    return refreshOutfitDetailPanel();
}

function toggleDraftAcc(accId) {
    return toggleAccessoryDraftAcc(accId);
}

function saveFocusedKitDraft() {
    return saveAccessoryFocusedKitDraft();
}

function toggleDisabledAcc(partKey, outfitId, accId) {
    return toggleAccessoryDisabledAcc(partKey, outfitId, accId);
}

function filterActiveForCurrentMode() {
    return state.accMode ? (state.filterNoCat || state.filterNoDesc) : (state.filterNoCat || state.filterNoTag || state.filterNoDesc);
}

function updateSearchPlaceholder() {
    var inp = document.getElementById('om-search-inp');
    if (inp) inp.placeholder = state.accMode ? '搜索单品…' : '搜索穿搭…';
}

function updateFilterBarForMode() {
    var tagChip = document.getElementById('om-filter-notag');
    if (tagChip) tagChip.style.display = state.accMode ? 'none' : '';
    var fbtn = document.getElementById('om-filter-toggle');
    if (fbtn) fbtn.classList.toggle('om-filter-active', filterActiveForCurrentMode());
}

function updateBatchButtonState() {
    var btn = document.getElementById('om-batch-toggle');
    if (btn) btn.classList.toggle('on', state.batchMode);
}


// ── 打开全屏主界面 ────────────────────────────────────────
function openPopup() {
    if (document.querySelector('.om-overlay')) return;
    var shield = document.createElement('div');
    shield.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483646;');
    shield.addEventListener('touchstart', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    shield.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); }, { passive: false });
    document.body.appendChild(shield);
    setTimeout(function () { if (shield.parentNode) shield.parentNode.removeChild(shield); }, 400);

    injectStyles();
    state.batchMode = false; state.batchSelected = []; state.searchQuery = ''; state.searchOpen = false; resetOutfitsUiState();
    state.catDrillParent = null; state.curSubCat = null;
    state.filterOpen = false; state.filterNoCat = false; state.filterNoTag = false; state.filterNoDesc = false;
    state.accMode = false; state.accCat = '__all__'; state.accDrillParent = null; state.accSubCat = null;
    clearKitDraft();

    var meta = loadMeta();
    var isUser = meta.currentView !== 'char';
    state.darkMode = meta.darkMode === true;

    var ov = document.createElement('div');
    ov.className = 'om-overlay ' + (state.darkMode ? 'om-dark' : 'om-light');
    ov.setAttribute('style', 'position:fixed !important;top:0 !important;left:0 !important;right:0 !important;bottom:0 !important;z-index:2147483647 !important;');

    ov.innerHTML =
        '<div class="om-box">' +
        '<div class="om-head">' +
        '<div class="om-head-title"><i class="fa-solid fa-shirt"></i>' + SCRIPT_NAME + '<span class="om-version">v' + esc(OM_VERSION) + '</span></div>' +
        '<div class="om-head-actions">' +
        '<button class="om-icon-btn" id="om-search-toggle" title="搜索"><i class="fa-solid fa-magnifying-glass"></i></button>' +
        '<button class="om-icon-btn" id="om-filter-toggle" title="筛选"><i class="fa-solid fa-filter"></i></button>' +
        '<button class="om-icon-btn" id="om-view-toggle" title="' + (isUser ? '切换到角色衣柜' : '切换到User衣柜') + '"><i class="fa-solid ' + (isUser ? 'fa-user' : 'fa-masks-theater') + '"></i></button>' +
        '<button class="om-icon-btn" id="om-theme-toggle" title="' + (state.darkMode ? '切换到日间模式' : '切换到夜间模式') + '" aria-label="夜间模式" aria-pressed="' + state.darkMode + '"><i class="' + (state.darkMode ? 'fa-solid fa-circle-half-stroke' : 'fa-regular fa-sun') + '"></i></button>' +
        '<button class="om-icon-btn" id="om-x" title="关闭"><i class="fa-solid fa-xmark"></i></button>' +
        '</div></div>' +
        '<div class="om-search-bar" id="om-search-bar">' +
        '<div class="om-search-wrap"><i class="fa-solid fa-magnifying-glass"></i>' +
        '<input class="om-search-inp" id="om-search-inp" type="text" placeholder="搜索名称或标签…" autocomplete="off" /></div>' +
        '<button class="om-search-clear" id="om-search-clear" title="关闭搜索"><i class="fa-solid fa-xmark"></i></button>' +
        '</div>' +
        '<div class="om-filter-bar" id="om-filter-bar">' +
        '<button class="om-filter-chip" id="om-filter-nocat">未分类</button>' +
        '<button class="om-filter-chip" id="om-filter-notag">无标签</button>' +
        '<button class="om-filter-chip" id="om-filter-nodesc">无描述</button>' +
        '</div>' +
        '<div class="om-viewbar" id="om-viewbar"></div>' +
        '<div class="om-catbar-wrap">' +
        '<div class="om-catbar" id="om-catbar"></div>' +
        '<button class="om-acc-toggle" id="om-acc-toggle" title="单品"><i class="fa-solid fa-chevron-down"></i></button>' +
        '</div>' +
        '<div class="om-acc-catbar" id="om-acc-catbar"></div>' +
        '<div class="om-batch-area" id="om-batch-area"></div>' +
        '<div class="om-grid-area" id="om-grid-area"></div>' +
        '<div class="om-bottombar" id="om-bottombar" style="position:relative;">' +
        '<div class="om-bottom-status" id="om-bottom-status"></div>' +
        '<button class="om-bottom-btn" id="om-batch-toggle" title="多选"><i class="fa-solid fa-list-check"></i></button>' +
        '<button class="om-bottom-btn" id="om-bottom-presets" title="预设"><i class="fa-solid fa-bookmark"></i></button>' +
        '<button class="om-bottom-btn" id="om-bottom-settings" title="设置"><i class="fa-solid fa-sliders"></i></button>' +
        '</div>' +
        '</div>' +
        '<div id="om-popup-slot" style="position:absolute;inset:0;z-index:999;pointer-events:none;"></div>';

    document.body.appendChild(ov);

    // 绑定顶栏
    ov.querySelector('#om-x').addEventListener('click', closePopup);
    ov.querySelector('#om-theme-toggle').addEventListener('click', function () {
        state.darkMode = !state.darkMode;
        var themeMeta = loadMeta();
        themeMeta.darkMode = state.darkMode;
        saveMeta(themeMeta);
        var overlay = document.querySelector('.om-overlay');
        if (overlay) {
            overlay.classList.toggle('om-dark', state.darkMode);
            overlay.classList.toggle('om-light', !state.darkMode);
        }
        var btn = ov.querySelector('#om-theme-toggle');
        if (btn) btn.innerHTML = state.darkMode
            ? '<i class="fa-solid fa-circle-half-stroke"></i>'
            : '<i class="fa-regular fa-sun"></i>';
        if (btn) {
            btn.title = state.darkMode ? '切换到日间模式' : '切换到夜间模式';
            btn.setAttribute('aria-pressed', String(state.darkMode));
        }
    });
    // 视角切换
    ov.querySelector('#om-view-toggle').addEventListener('click', function () {
        var m = loadMeta();
        m.currentView = m.currentView === 'char' ? 'user' : 'char';
        saveMeta(m);
        charPanelExpanded = false;
        state.curCat = '__all__'; state.catDrillParent = null; state.curSubCat = null;
        clearKitDraft();
        closeDetailPanel();
        var isNowUser = m.currentView !== 'char';
        var vBtn = ov.querySelector('#om-view-toggle');
        if (vBtn) {
            vBtn.innerHTML = '<i class="fa-solid ' + (isNowUser ? 'fa-user' : 'fa-masks-theater') + '"></i>';
            vBtn.title = isNowUser ? '切换到角色衣柜' : '切换到User衣柜';
        }
        renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
    });
    // 搜索
    ov.querySelector('#om-search-toggle').addEventListener('click', function () {
        state.searchOpen = !state.searchOpen;
        var bar = document.getElementById('om-search-bar');
        bar.classList.toggle('open', state.searchOpen);
        if (state.searchOpen) { setTimeout(function () { var i = document.getElementById('om-search-inp'); if (i) i.focus(); }, 50); }
        else { state.searchQuery = ''; renderGrid(); }
    });
    ov.querySelector('#om-search-clear').addEventListener('click', function () {
        state.searchOpen = false;
        state.searchQuery = '';
        var bar = document.getElementById('om-search-bar');
        bar.classList.remove('open');
        renderGrid();
    });
    var sinp = ov.querySelector('#om-search-inp');
    updateSearchPlaceholder();
    sinp.addEventListener('input', function () { state.searchQuery = sinp.value; renderGrid(); });
    sinp.addEventListener('keydown', function (e) { if (e.key === 'Escape') { state.searchOpen = false; state.searchQuery = ''; ov.querySelector('#om-search-bar').classList.remove('open'); renderGrid(); } });
    // 筛选
    ov.querySelector('#om-filter-toggle').addEventListener('click', function () {
        state.filterOpen = !state.filterOpen;
        var fbar = document.getElementById('om-filter-bar');
        updateFilterBarForMode();
        fbar.classList.toggle('open', state.filterOpen);
    });
    function bindFilterChip(id, key) {
        ov.querySelector(id).addEventListener('click', function () {
            if (state.accMode && key === 'filterNoTag') return;
            state[key] = !state[key];
            this.classList.toggle('on', state[key]);
            updateFilterBarForMode();
            renderGrid();
        });
    }
    bindFilterChip('#om-filter-nocat', 'filterNoCat');
    bindFilterChip('#om-filter-notag', 'filterNoTag');
    bindFilterChip('#om-filter-nodesc', 'filterNoDesc');

    // 绑定底栏
    ov.querySelector('#om-bottom-status').addEventListener('click', function () { toggleDetailPanel(); });
    ov.querySelector('#om-batch-toggle').addEventListener('click', function () {
        state.batchMode = !state.batchMode; state.batchSelected = [];
        updateBatchButtonState();
        renderGrid();
    });
    ov.querySelector('#om-bottom-presets').addEventListener('click', function () { fn.openPresetsSheet(); });
    ov.querySelector('#om-bottom-settings').addEventListener('click', function () { fn.openSettingsSheet(); });

    // 单品栏展开/折叠
    ov.querySelector('#om-acc-toggle').addEventListener('click', function () {
        state.accMode = !state.accMode;
        state.batchMode = false;
        state.batchSelected = [];
        if (state.accMode) ensureKitFocusForAccMode(false);
        else clearKitDraft();
        updateBatchButtonState();
        updateSearchPlaceholder();
        updateFilterBarForMode();
        var btn = ov.querySelector('#om-acc-toggle');
        if (btn) {
            btn.classList.toggle('open', state.accMode);
            btn.innerHTML = state.accMode
                ? '<i class="fa-solid fa-chevron-up"></i>'
                : '<i class="fa-solid fa-chevron-down"></i>';
        }
        renderAccCatbar();
        renderGrid();
        renderBottomStatus();
        if (state.accMode) {
            var groups = buildDetailGroups();
            if (groups.length > 0) openDetailPanel(groups);
        } else {
            closeDetailPanel();
        }
    });

    renderViewbar();
    renderCatbar();
    renderGrid();
    renderBottomStatus();
}

function closePopup() {
    disconnectOutfitGridObserver();
    clearKitDraft();
    var ov = document.querySelector('.om-overlay'); if (ov) ov.parentNode.removeChild(ov);
}

// ── 视角切换栏渲染 ──────────────────────────────────────────
// 角色管理（添加/重命名/删除/收藏/分组）仍使用 load()/save() 兼容层
// 因为这些操作涉及 charNames ↔ charIndex 双向翻译，兼容层已处理
var charPanelExpanded = false;
var collapsedGroups = {};

function renderViewbar() {
    var vbar = document.getElementById('om-viewbar'); if (!vbar) return;
    var meta = loadMeta();
    var isUser = meta.currentView !== 'char';
    vbar.style.position = 'relative';

    if (isUser) {
        vbar.style.display = 'none';
        return;
    }

    vbar.style.display = '';
    var currentCharName = '';
    if (meta.currentChar) {
        if (meta.currentChar === SHARED_CHAR_KEY) currentCharName = SHARED_CHAR_LABEL;
        else currentCharName = charNameById(meta.currentChar) || '';
    }
    var charLabel = currentCharName || '搜索角色…';

    var html = '<input type="text" class="om-char-input" id="om-char-input" placeholder="' + esc(charLabel) + '" autocomplete="off" />' +
        '<button class="om-char-add-btn" id="om-char-add" title="添加角色">+</button>';

    vbar.innerHTML = html;

    var inp = vbar.querySelector('#om-char-input');
    inp.addEventListener('focus', function () {
        charPanelExpanded = true;
        renderCharDropdown(vbar, load(), '');
    });
    inp.addEventListener('input', function () {
        charPanelExpanded = true;
        renderCharDropdown(vbar, load(), this.value.trim().toLowerCase());
    });
    vbar.querySelector('#om-char-add').addEventListener('click', function () { addCharPrompt(); });
    if (charPanelExpanded) renderCharDropdown(vbar, load(), '');
}

// renderCharDropdown 继续使用 load() 返回的旧格式（d.chars/d.charNames/d.charFavorites/d.charGroups）
// 因为角色管理操作（重命名/删除/分组/收藏）全部通过 save(d) 的兼容层处理 charIndex 翻译
function renderCharDropdown(vbar, d, query) {
    var old = vbar.querySelector('.om-char-dropdown');
    if (old) old.parentNode.removeChild(old);

    var favs = d.charFavorites || [];
    var groups = d.charGroups || {};
    var allNames = d.charNames || [];
    var matchedGroupKeys = {};
    if (query) { for (var gg in groups) { if (gg.toLowerCase().indexOf(query) !== -1) matchedGroupKeys[gg] = true; } }

    function visible(cn) {
        if (!query) return true;
        if (cn.toLowerCase().indexOf(query) !== -1) return true;
        for (var gg2 in matchedGroupKeys) { if ((groups[gg2] || []).indexOf(cn) !== -1) return true; }
        return false;
    }

    var inGroup = {};
    for (var gn in groups) { (groups[gn] || []).forEach(function (n) { inGroup[n] = true; }); }

    function makeRow(cn) {
        if (!visible(cn)) return '';
        var isFav = favs.indexOf(cn) !== -1;
        var isActive = d.currentChar === cn;
        var cd = d.chars && d.chars[cn] ? d.chars[cn] : { outfits: [] };
        var count = (cd.outfits || []).length;
        return '<div class="om-char-row' + (isActive ? ' active' : '') + '" data-cn="' + esc(cn) + '">' +
            '<i class="fa-' + (isFav ? 'solid' : 'regular') + ' fa-star om-char-star' + (isFav ? ' on' : '') + '" data-cn="' + esc(cn) + '"></i>' +
            '<span class="om-char-rname">' + esc(cn) + '</span>' +
            '<span class="om-char-count">' + count + '套</span>' +
            '<div class="om-char-actions">' +
            '<button class="om-char-act om-char-rename" data-cn="' + esc(cn) + '" title="重命名"><i class="fa-solid fa-pen"></i></button>' +
            '<button class="om-char-act om-char-move-group" data-cn="' + esc(cn) + '" title="分组"><i class="fa-solid fa-folder"></i></button>' +
            '<button class="om-char-act om-char-delete" data-cn="' + esc(cn) + '" title="删除" style="color:#e57373"><i class="fa-solid fa-trash"></i></button>' +
            '</div></div>';
    }

    function makeSection(title, iconClass, names, gkey, managedGroupName) {
        var visNames = names.filter(visible);
        var isManaged = typeof managedGroupName === 'string';
        if (visNames.length === 0 && (!isManaged || (query && !matchedGroupKeys[managedGroupName]))) return '';
        var isCollapsed = collapsedGroups[gkey];
        var html = '<div class="om-char-group-hdr" data-gkey="' + esc(gkey) + '">' +
            '<i class="fa-solid fa-chevron-down om-g-arrow' + (isCollapsed ? ' collapsed' : '') + '"></i>' +
            '<i class="' + iconClass + ' om-g-icon"></i>' +
            '<span class="om-char-group-title">' + esc(title) + '</span>' +
            '<span class="om-char-group-count">(' + visNames.length + ')</span>' +
            (isManaged
                ? '<span class="om-char-group-actions">' +
                    '<button class="om-char-group-act om-char-group-rename" data-group="' + esc(managedGroupName) + '" title="重命名分组"><i class="fa-solid fa-pen"></i></button>' +
                    '<button class="om-char-group-act om-char-group-delete" data-group="' + esc(managedGroupName) + '" title="删除分组"><i class="fa-solid fa-trash"></i></button>' +
                  '</span>'
                : '') +
            '</div>';
        if (!isCollapsed) { visNames.forEach(function (cn) { html += makeRow(cn); }); }
        return html;
    }

    var listHtml = '';
    // 通用衣柜
    var sharedPartKey = 'char:' + SHARED_CHAR_KEY;
    var sharedCd = d.chars && d.chars[SHARED_CHAR_KEY] ? d.chars[SHARED_CHAR_KEY] : { outfits: [] };
    var sharedCount = (sharedCd.outfits || []).length;
    var sharedActive = d.currentChar === SHARED_CHAR_KEY;
    if (!query || SHARED_CHAR_LABEL.toLowerCase().indexOf(query) !== -1 || '通用'.indexOf(query) !== -1) {
        listHtml += '<div class="om-char-row' + (sharedActive ? ' active' : '') + '" data-cn="' + SHARED_CHAR_KEY + '" style="border-bottom:1px solid rgba(127,127,127,.1)">' +
            '<i class="fa-solid fa-globe om-char-star on" style="cursor:default"></i>' +
            '<span class="om-char-rname">' + SHARED_CHAR_LABEL + '</span>' +
            '<span class="om-char-count">' + sharedCount + '套</span>' +
            '<div class="om-char-actions"></div></div>';
    }
    var favNames = allNames.filter(function (n) { return favs.indexOf(n) !== -1; });
    listHtml += makeSection('收藏', 'fa-solid fa-star', favNames, '__fav__');
    for (var gn2 in groups) {
        var gNames = (groups[gn2] || []).filter(function (n) { return allNames.indexOf(n) !== -1; });
        listHtml += makeSection(gn2, 'fa-solid fa-folder', gNames, 'g_' + gn2, gn2);
    }
    var ungrouped = allNames.filter(function (n) { return !inGroup[n] && favs.indexOf(n) === -1; });
    if (ungrouped.length > 0) {
        var ugLabel = (favNames.length > 0 || Object.keys(groups).length > 0) ? '未分组' : '全部角色';
        listHtml += makeSection(ugLabel, 'fa-regular fa-folder-open', ungrouped, '__ungrouped__');
    }
    if (allNames.length === 0) listHtml += '<div class="om-char-empty">还没有角色，点 + 添加</div>';

    var dropdown = document.createElement('div');
    dropdown.className = 'om-char-dropdown';
    dropdown.innerHTML = listHtml;
    vbar.appendChild(dropdown);

    // 分组折叠
    dropdown.querySelectorAll('.om-char-group-hdr').forEach(function (hdr) {
        hdr.addEventListener('click', function () {
            collapsedGroups[hdr.dataset.gkey] = !collapsedGroups[hdr.dataset.gkey];
            renderCharDropdown(vbar, load(), query);
        });
    });
    // 自定义分组改名
    dropdown.querySelectorAll('.om-char-group-rename').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var oldName = btn.dataset.group;
            var newName = prompt('重命名分组「' + oldName + '」：', oldName);
            if (newName === null) return;
            var dd = load();
            var result = renameCharGroup(dd, oldName, newName);
            if (!result.ok) {
                if (result.code === 'GROUP_NAME_EXISTS') toast('分组「' + newName.trim() + '」已存在', true);
                else if (result.code !== 'GROUP_NAME_UNCHANGED') toast('分组名称不能为空或使用保留名称', true);
                return;
            }
            var oldCollapseKey = 'g_' + oldName;
            var newCollapseKey = 'g_' + result.newName;
            if (Object.prototype.hasOwnProperty.call(collapsedGroups, oldCollapseKey)) {
                collapsedGroups[newCollapseKey] = collapsedGroups[oldCollapseKey];
                delete collapsedGroups[oldCollapseKey];
            }
            save(dd);
            renderCharDropdown(vbar, load(), query);
            toast('分组已重命名为「' + result.newName + '」');
        });
    });
    // 自定义分组删除：1 仅解散；2 连同组内角色衣柜删除
    dropdown.querySelectorAll('.om-char-group-delete').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var groupName = btn.dataset.group;
            var dd = load();
            var memberSeen = Object.create(null);
            var members = dd.charGroups && Array.isArray(dd.charGroups[groupName])
                ? dd.charGroups[groupName].filter(function (name) {
                    if ((dd.charNames || []).indexOf(name) === -1 || memberSeen[name]) return false;
                    memberSeen[name] = true;
                    return true;
                })
                : [];
            var choice = prompt(
                '删除分组「' + groupName + '」（' + members.length + ' 个角色）：\n' +
                '1. 仅解散分组，保留角色衣柜\n' +
                '2. 删除分组及组内所有角色衣柜\n\n请输入 1 或 2：',
                '1'
            );
            if (choice === null) return;
            choice = choice.trim();
            if (choice !== '1' && choice !== '2') { toast('请输入 1 或 2', true); return; }
            var removeWardrobes = choice === '2';
            if (removeWardrobes) {
                var preview = members.slice(0, 8).join('、') + (members.length > 8 ? ' 等' : '');
                if (!confirm('确定删除分组「' + groupName + '」及组内所有角色衣柜？' + (preview ? '\n将删除：' + preview : '') + '\n此操作不可撤销。')) return;
            }
            var result = deleteCharGroup(dd, groupName, removeWardrobes);
            if (!result.ok) { toast('分组不存在或已被删除', true); return; }
            delete collapsedGroups['g_' + groupName];
            save(dd);
            renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
            toast(removeWardrobes
                ? '已删除分组及 ' + result.deletedNames.length + ' 个角色衣柜'
                : '已解散分组「' + groupName + '」，角色衣柜已保留');
        });
    });
    // 选中角色
    dropdown.querySelectorAll('.om-char-row').forEach(function (row) {
        row.addEventListener('click', function (e) {
            if (e.target.closest('.om-char-star') || e.target.closest('.om-char-actions')) return;
            var dd = load(); dd.currentChar = row.dataset.cn; save(dd);
            charPanelExpanded = false;
            state.curCat = '__all__'; state.catDrillParent = null; state.curSubCat = null;
            renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
        });
    });
    // 收藏
    dropdown.querySelectorAll('.om-char-star').forEach(function (star) {
        star.addEventListener('click', function (e) {
            e.stopPropagation();
            var dd = load(); if (!dd.charFavorites) dd.charFavorites = [];
            var cn = star.dataset.cn; var idx = dd.charFavorites.indexOf(cn);
            if (idx !== -1) dd.charFavorites.splice(idx, 1); else dd.charFavorites.push(cn);
            save(dd); renderCharDropdown(vbar, load(), query);
        });
    });
    // 重命名
    dropdown.querySelectorAll('.om-char-rename').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation(); var cn = btn.dataset.cn;
            var nw = prompt('重命名角色「' + cn + '」：', cn);
            if (!nw || !nw.trim() || nw.trim() === cn) return; nw = nw.trim();
            var dd = load();
            if (dd.charNames.indexOf(nw) !== -1) { toast('角色「' + nw + '」已存在', true); return; }
            var idx = dd.charNames.indexOf(cn); if (idx !== -1) dd.charNames[idx] = nw;
            if (dd.chars && dd.chars[cn]) { dd.chars[nw] = dd.chars[cn]; delete dd.chars[cn]; }
            if (dd.charFavorites) { var fi = dd.charFavorites.indexOf(cn); if (fi !== -1) dd.charFavorites[fi] = nw; }
            if (dd.charGroups) { for (var g in dd.charGroups) { var gi = dd.charGroups[g].indexOf(cn); if (gi !== -1) dd.charGroups[g][gi] = nw; } }
            if (dd.currentChar === cn) dd.currentChar = nw;
            save(dd); renderViewbar(); renderCatbar(); renderGrid(); toast('已重命名为「' + nw + '」');
        });
    });
    // 分组移动
    dropdown.querySelectorAll('.om-char-move-group').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation(); var cn = btn.dataset.cn; var dd = load();
            if (!dd.charGroups) dd.charGroups = {};
            var gNamesList = Object.keys(dd.charGroups);
            if (gNamesList.length === 0) {
                var gname = prompt('还没有分组，输入新分组名称：');
                if (!gname || !gname.trim()) return;
                gname = gname.trim();
                if (!validNewCharGroupName(dd.charGroups, gname)) { toast('分组名称已存在、为空或使用了保留名称', true); return; }
                dd.charGroups[gname] = [cn]; save(dd); renderCharDropdown(vbar, load(), query);
                toast('已创建分组并移入'); return;
            }
            var currentGroup = '';
            for (var g in dd.charGroups) { if ((dd.charGroups[g] || []).indexOf(cn) !== -1) { currentGroup = g; break; } }
            var msg = '将「' + cn + '」移到：\n0. 不分组' + (currentGroup ? '（当前：' + currentGroup + '）' : '') + '\n';
            gNamesList.forEach(function (g, i) { msg += (i + 1) + '. ' + g + '\n'; });
            msg += (gNamesList.length + 1) + '. 新建分组';
            var choice = prompt(msg); if (choice === null) return;
            var ci = parseInt(choice);
            for (var g2 in dd.charGroups) { var ri = dd.charGroups[g2].indexOf(cn); if (ri !== -1) dd.charGroups[g2].splice(ri, 1); }
            if (ci > 0 && ci <= gNamesList.length) { dd.charGroups[gNamesList[ci - 1]].push(cn); toast('已移入「' + gNamesList[ci - 1] + '」'); }
            else if (ci === gNamesList.length + 1) {
                var ng = prompt('新分组名称：');
                if (!ng || !ng.trim()) return;
                ng = ng.trim();
                if (!validNewCharGroupName(dd.charGroups, ng)) { toast('分组名称已存在、为空或使用了保留名称', true); return; }
                dd.charGroups[ng] = [cn]; toast('已创建分组并移入');
            }
            else { toast('已移出分组'); }
            save(dd); renderCharDropdown(vbar, load(), query);
        });
    });
    // 删除
    dropdown.querySelectorAll('.om-char-delete').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation(); var cn = btn.dataset.cn;
            if (!confirm('删除角色「' + cn + '」及其所有穿搭？')) return;
            var dd = load();
            if (dd.chars) delete dd.chars[cn];
            var idx = dd.charNames.indexOf(cn); if (idx !== -1) dd.charNames.splice(idx, 1);
            if (dd.charFavorites) { var fi = dd.charFavorites.indexOf(cn); if (fi !== -1) dd.charFavorites.splice(fi, 1); }
            if (dd.charGroups) { for (var g in dd.charGroups) { var gi = dd.charGroups[g].indexOf(cn); if (gi !== -1) dd.charGroups[g].splice(gi, 1); } }
            if (dd.currentChar === cn) dd.currentChar = SHARED_CHAR_KEY;
            save(dd); renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus(); toast('已删除角色「' + cn + '」');
        });
    });
    // 点击外部关闭
    function closeOnOutside(e) {
        if (!vbar.contains(e.target)) {
            charPanelExpanded = false;
            var dd2 = vbar.querySelector('.om-char-dropdown');
            if (dd2) dd2.parentNode.removeChild(dd2);
            document.removeEventListener('click', closeOnOutside, true);
        }
    }
    setTimeout(function () { document.addEventListener('click', closeOnOutside, true); }, 50);
}

function validNewCharGroupName(groups, name) {
    if (!name || name === '__proto__' || name === 'prototype' || name === 'constructor') return false;
    return !Object.prototype.hasOwnProperty.call(groups || {}, name);
}

function addCharPrompt() {
    var name = prompt('输入角色名：');
    if (!name || !name.trim()) return; name = name.trim();
    if (name === SHARED_CHAR_KEY) { toast('此名称为系统保留，请换一个', true); return; }
    var dd = load();
    if (!dd.charNames) dd.charNames = [];
    if (dd.charNames.indexOf(name) !== -1) { toast('角色「' + name + '」已存在', true); return; }
    dd.charNames.push(name); dd.currentChar = name; save(dd);
    charPanelExpanded = false;
    renderViewbar(); renderCatbar(); renderGrid(); renderBottomStatus();
    toast('✅ 已添加角色「' + name + '」');
}

function renderCharPanel() { /* 兼容 */ }

// ── 分类栏渲染（使用新 API）────────────────────────────────
function renderCatbar() {
    return renderOutfitCatbar();
}

// ── 单品分类栏渲染 ─────────────────────────────────────────
function renderAccCatbar() {
    return renderAccessoryCatbar();
}


// ── 网格区渲染（使用新 API）────────────────────────────────
function renderGrid() {
    var area = document.getElementById('om-grid-area'); if (!area) return;
    var meta = loadMeta();

    // 角色视角但没选角色
    if (meta.currentView === 'char' && !meta.currentChar) {
        area.innerHTML = '<div class="om-empty"><i class="fa-solid fa-masks-theater"></i><span>请先选择或添加一个角色</span></div>';
        return;
    }

    var part = loadCurrent();

    // ── 单品模式：显示单品卡片 ──
    if (state.accMode) {
        renderAccGrid(area, part);
        return;
    }

    renderOutfitGrid(area, part);
}

// ── 单品网格渲染 ────────────────────────────────────────
function renderAccGrid(area, part) {
    return renderAccessoryGrid(area, part);
}


// ── 底栏状态（使用 loadActivePartitions 跨分包显示）────────
function renderBottomStatus() {
    return renderOutfitBottomStatus();
}

// ── 选择详情面板 ─────────────────────────────────────────
function buildDetailGroups() {
    return buildOutfitDetailGroups();
}

function toggleDetailPanel() {
    return toggleOutfitDetailPanel();
}

function openDetailPanel(groups) {
    return openOutfitDetailPanel(groups);
}

function closeDetailPanel() {
    return closeOutfitDetailPanel();
}


// ── 注册到共享桥 ─────────────────────────────────────────
export { openPopup, closePopup, renderGrid, renderCatbar, renderAccCatbar, renderViewbar, renderBottomStatus, preResolveActiveImages };

export function registerMainFn() {
    fn.openPopup = openPopup;
    fn.closePopup = closePopup;
    fn.renderGrid = renderGrid;
    fn.renderCatbar = renderCatbar;
    fn.renderAccCatbar = renderAccCatbar;
    fn.renderViewbar = renderViewbar;
    fn.renderBottomStatus = renderBottomStatus;
    fn.closeDetailPanel = closeDetailPanel;
    fn.preResolveActiveImages = preResolveActiveImages;
    fn.toggleDraftAcc = toggleDraftAcc;
    fn.draftHasAcc = draftHasAcc;
    fn.outfitsInternalClearKitDraft = clearKitDraft;
    fn.outfitsInternalIsCurrentKitFocus = isCurrentKitFocus;
    fn.outfitsInternalSetKitFocus = setKitFocus;
    fn.outfitsInternalEnsureKitFocusForAccMode = ensureKitFocusForAccMode;
    fn.outfitsInternalToggleDisabledAcc = toggleDisabledAcc;
    fn.outfitsInternalSaveFocusedKitDraft = saveFocusedKitDraft;
    fn.outfitsInternalRefreshDetailPanel = refreshDetailPanel;
    fn.accessoriesInternalUpdateBatchButtonState = updateBatchButtonState;
}
