// ── 穿搭管理器 · 主体穿搭界面 ──────────────────────────────
// 穿搭分类、网格、卡片操作、活跃状态与详情面板

import {
    loadMeta,
    loadCurrent, saveCurrent,
    loadPartition, savePartition,
    currentPartKey, currentUserPartKey,
    syncActivePartitions,
    loadActivePartitions,
    charNameById,
    isServerMode, resolveImageForExternal, getImageUrlPrefix
} from './db.js';
import {
    getCatNames, getSubCats, hasSubCats,
    partGetById, partIsActive, partGetAccById, partOutfitNumbers,
    getActiveKit, getKitAccessories, ensureOutfitKits,
    SHARED_CHAR_KEY
} from './data.js';
import { esc, toast, getPopupLayer, uniqueIds } from './utils.js';
import { batchClassifyOutfits } from './api.js';
import { state, fn } from './bridge.js';
import { bindSceneCategories } from './ui-scene.js';
import { sceneEntry } from './scene-wardrobe.js';

var detailPanelOpen = false;
var gridImageObserver = null;
var OM_TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';

function clearKitDraft() {
    fn.outfitsInternalClearKitDraft();
}

function isCurrentKitFocus(partKey, outfitId) {
    return fn.outfitsInternalIsCurrentKitFocus(partKey, outfitId);
}

function setKitFocus(partKey, outfitId) {
    return fn.outfitsInternalSetKitFocus(partKey, outfitId);
}

export function resetOutfitsUiState() {
    detailPanelOpen = false;
}

export function disconnectOutfitGridObserver() {
    if (gridImageObserver) { gridImageObserver.disconnect(); gridImageObserver = null; }
}

// ── 预解析活跃穿搭图片（server模式下）──────────────────
export function preResolveActiveImages() {
    if (!isServerMode()) return;
    var prefix = getImageUrlPrefix();
    var activeParts = loadActivePartitions();

    function resolveForPartition(part) {
        if (!part || !part.activeIds || !part.outfits) return;
        part.activeIds.forEach(function (id) {
            var o = partGetById(part, id);
            if (!o || !o.imageData || typeof o.imageData !== 'string') return;
            if (o.imageData.indexOf(prefix) !== 0) return;
            if (state.resolvedImages[o.id] && state.resolvedImages[o.id].url === o.imageData) return;
            (function (outfit) {
                resolveImageForExternal(outfit.imageData, function (dataUrl) {
                    state.resolvedImages[outfit.id] = { url: outfit.imageData, dataUrl: dataUrl };
                });
            })(o);
        });
    }

    for (var pk in activeParts) {
        resolveForPartition(activeParts[pk]);
    }
}

function openAutoClassifyModal(ids) {
    var meta = loadMeta();
    var apiCfg = meta.apiVision || {};
    if (!apiCfg.endpoint || !apiCfg.key || !apiCfg.model) {
        toast('请先在设置中配置"描述生成 API"', true);
        return;
    }
    var sourcePartKey = currentPartKey();
    var sourcePart = loadPartition(sourcePartKey);
    var cats = sourcePart.categories || [];
    if (getCatNames(cats).length === 0) {
        toast('还没有分类，无法自动分类', true);
        return;
    }
    var queue = uniqueIds(ids).map(function (id) { return partGetById(sourcePart, id); })
        .filter(function (o) { return o && o.imageData; });
    if (queue.length === 0) {
        toast('所选穿搭中没有带图片的', true);
        return;
    }

    var _mp = getPopupLayer();
    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    modal.dataset.running = '1';
    modal.innerHTML = '<div class="om-modal-box">' +
        '<div class="om-modal-title"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>自动分类</div>' +
        '<div class="om-hint">只根据图片判断分类，不生成描述或名称</div>' +
        '<div id="om-autocat-status" style="font-size:.82em;margin-top:4px">准备中...</div>' +
        '<div style="height:6px;background:rgba(127,127,127,.15);border-radius:3px;overflow:hidden;margin:3px 0 6px">' +
        '<div id="om-autocat-bar" style="height:100%;width:0%;background:var(--SmartThemeQuoteColor,#7c6daf);border-radius:3px;transition:width .25s"></div></div>' +
        '<div id="om-autocat-result" style="font-size:.78em;opacity:.62;max-height:120px;overflow-y:auto"></div>' +
        '<div class="om-btn-row" style="margin-top:10px" id="om-autocat-actions">' +
        '<button class="om-btn om-btn-outline" id="om-autocat-close">后台运行</button></div></div>';
    _mp.appendChild(modal);

    var modalAlive = true;
    function removeModal() {
        if (modalAlive && modal.parentNode) {
            modal.parentNode.removeChild(modal);
            modalAlive = false;
        }
    }
    var statusEl = modal.querySelector('#om-autocat-status');
    var barEl = modal.querySelector('#om-autocat-bar');
    var resultEl = modal.querySelector('#om-autocat-result');
    var closeBtn = modal.querySelector('#om-autocat-close');
    modal.addEventListener('click', function (e) {
        if (e.target === modal && !modal.dataset.running) removeModal();
    });
    closeBtn.onclick = function () {
        removeModal();
        toast('自动分类正在后台运行，完成后会通知');
    };

    function appendResult(text, ok) {
        if (!modalAlive) return;
        var row = document.createElement('div');
        row.style.cssText = 'padding:2px 0;color:' + (ok ? 'inherit' : '#e57373');
        row.textContent = text;
        resultEl.appendChild(row);
        resultEl.scrollTop = resultEl.scrollHeight;
    }
    batchClassifyOutfits(ids,
        function (done, total, msg) {
            var pct = total > 0 ? Math.round(done / total * 100) : 0;
            if (modalAlive) {
                statusEl.textContent = done + '/' + total + ' ' + msg;
                barEl.style.width = pct + '%';
            }
            appendResult(msg, msg.indexOf('❌') !== 0);
        },
        function (err, doneCount, errors) {
            var failCount = errors ? errors.length : 0;
            var successCount = (doneCount || 0) - failCount;
            delete modal.dataset.running;
            state.batchSelected = [];
            fn.renderCatbar();
            fn.renderGrid();
            renderBottomStatus();
            fn.updateBtn();
            if (modalAlive) {
                barEl.style.width = '100%';
                statusEl.textContent = err ? err : ('完成：已分类 ' + successCount + ' 套' + (failCount ? '，失败 ' + failCount + ' 套' : ''));
                closeBtn.textContent = '完成';
                closeBtn.className = 'om-btn om-btn-safe';
                closeBtn.onclick = function () { removeModal(); };
            } else {
                toast(err ? ('自动分类失败：' + err) : ('自动分类完成：' + successCount + ' 套' + (failCount ? '，失败 ' + failCount + ' 套' : '')));
            }
        }
    );
}

function setupGridLazyImages(area) {
    if (gridImageObserver) { gridImageObserver.disconnect(); gridImageObserver = null; }

    var imgs = area.querySelectorAll('img.om-lazy-img[data-outfit-id]');
    if (!imgs.length) return;

    function loadImg(img) {
        if (!img || img.dataset.loaded === '1') return;
        var id = img.getAttribute('data-outfit-id');
        var part = loadCurrent();
        var o = partGetById(part, id);
        if (!o || !o.imageData) return;
        img.dataset.loaded = '1';
        img.onload = function () { img.classList.add('om-loaded'); };
        img.onerror = function () { img.classList.add('om-loaded'); };
        img.src = o.imageData;
        img.removeAttribute('data-outfit-id');
        if (img.complete && img.naturalWidth) img.classList.add('om-loaded');
    }

    if (!('IntersectionObserver' in window)) { imgs.forEach(loadImg); return; }

    gridImageObserver = new IntersectionObserver(function (entries, observer) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting) return;
            loadImg(entry.target);
            observer.unobserve(entry.target);
        });
    }, { root: area, rootMargin: '400px 0px', threshold: 0.01 });

    imgs.forEach(function (img) { gridImageObserver.observe(img); });
    Array.prototype.slice.call(imgs, 0, 12).forEach(loadImg);
    setTimeout(function () {
        imgs.forEach(function (img) {
            if (img && img.dataset.loaded !== '1') loadImg(img);
        });
    }, 350);
}

// ── 分类栏渲染（使用新 API）────────────────────────────────
export function renderCatbar() {
    var catbar = document.getElementById('om-catbar'); if (!catbar) return;
    // Guard: 角色视角未选角色时不显示分类栏
    var meta = loadMeta();
    if (meta.currentView === 'char' && !meta.currentChar) {
        catbar.style.display = 'none';
        state.catDrillParent = null; state.curSubCat = null; state.curCat = '__all__';
        return;
    }
    var part = loadCurrent();
    var cats = part.categories || [];
    var catNames = getCatNames(cats);
    catbar.style.display = '';

    var html = '';

    if (state.catDrillParent) {
        var subCats = getSubCats(cats, state.catDrillParent);
        html += '<button class="om-catbtn om-catbtn-back" id="om-cat-back" title="返回上级"><i class="fa-solid fa-chevron-left"></i></button>';
        html += '<button class="om-catbtn' + (state.curSubCat === null ? ' on' : '') + '" data-sub="__all__">' + esc(state.catDrillParent) + '</button>';
        subCats.forEach(function (sc) {
            html += '<button class="om-catbtn' + (state.curSubCat === sc ? ' on' : '') + '" data-sub="' + esc(sc) + '">' + esc(sc) + '</button>';
        });
    } else {
        html += '<button class="om-catbtn' + (state.curCat === '__all__' ? ' on' : '') + '" data-c="__all__">全部</button>';
        catNames.forEach(function (c) {
            html += '<button class="om-catbtn' + (state.curCat === c ? ' on' : '') + '" data-c="' + esc(c) + '">' + esc(c) + '</button>';
        });
    }

    catbar.innerHTML = html;
    bindSceneCategories(catbar);

    if (state.catDrillParent) {
        catbar.querySelector('#om-cat-back').addEventListener('click', function () {
            state.catDrillParent = null; state.curSubCat = null; state.curCat = '__all__';
            renderCatbar(); fn.renderGrid();
        });
        catbar.querySelectorAll('.om-catbtn[data-sub]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var sub = btn.dataset.sub;
                if (sub === '__all__') state.curSubCat = null;
                else state.curSubCat = sub;
                renderCatbar(); fn.renderGrid();
            });
        });
    } else {
        catbar.querySelectorAll('.om-catbtn[data-c]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var c = btn.dataset.c;
                if (c === '__all__') {
                    state.curCat = '__all__'; state.catDrillParent = null; state.curSubCat = null;
                    renderCatbar(); fn.renderGrid();
                } else {
                    if (hasSubCats(cats, c)) {
                        state.catDrillParent = c; state.curCat = c; state.curSubCat = null;
                        renderCatbar(); fn.renderGrid();
                    } else {
                        state.curCat = c; state.catDrillParent = null; state.curSubCat = null;
                        renderCatbar(); fn.renderGrid();
                    }
                }
            });
        });
    }

    // 电脑端：鼠标滚轮横向滚动 + 拖拽
    if (!catbar._wheelBound) {
        catbar.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaY) > 0) {
                e.preventDefault();
                catbar.scrollLeft += e.deltaY;
            }
        }, { passive: false });
        var _drag = { down: false, startX: 0, scrollL: 0 };
        catbar.addEventListener('mousedown', function (e) {
            _drag.down = true; _drag.startX = e.pageX; _drag.scrollL = catbar.scrollLeft;
            catbar.style.cursor = 'grabbing'; catbar.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', function (e) {
            if (!_drag.down) return;
            catbar.scrollLeft = _drag.scrollL - (e.pageX - _drag.startX);
        });
        document.addEventListener('mouseup', function () {
            if (_drag.down) { _drag.down = false; catbar.style.cursor = ''; catbar.style.userSelect = ''; }
        });
        catbar._wheelBound = true;
    }
}

// ── 穿搭网格渲染 ──────────────────────────────────────────
export function renderOutfitGrid(area, part) {
    var allOutfits = part.outfits || [];
    var outfitNumbers = partOutfitNumbers(part);
    var scene = sceneEntry(currentPartKey());

    // 按分类过滤
    var list;
    if (state.catDrillParent) {
        var parentCat = state.catDrillParent;
        var inParent = allOutfits.filter(function (o) { return o.category === parentCat; });
        if (state.curSubCat === null) list = inParent;
        else list = inParent.filter(function (o) { return o.subCategory === state.curSubCat; });
    } else if (state.curCat === '__all__') {
        list = allOutfits;
    } else {
        list = allOutfits.filter(function (o) { return o.category === state.curCat; });
    }
    if (state.searchQuery) {
        var q = state.searchQuery.toLowerCase();
        list = list.filter(function (o) {
            return (o.name && o.name.toLowerCase().indexOf(q) !== -1) ||
                (o.category && o.category.toLowerCase().indexOf(q) !== -1) ||
                (o.sceneTag && o.sceneTag.toLowerCase().indexOf(q) !== -1) ||
                (o.description && o.description.toLowerCase().indexOf(q) !== -1);
        });
    }
    // 筛选过滤
    if (state.filterNoCat) {
        if (state.curCat === '__all__' && !state.catDrillParent) {
            list = list.filter(function (o) { return !o.category || !o.category.trim(); });
        } else {
            var curCatKey = state.catDrillParent || state.curCat;
            var cats = part.categories || [];
            if (hasSubCats(cats, curCatKey)) {
                list = list.filter(function (o) { return !o.subCategory || !o.subCategory.trim(); });
            }
        }
    }
    if (state.filterNoTag) { list = list.filter(function (o) { return !o.sceneTag || !o.sceneTag.trim(); }); }
    if (state.filterNoDesc) { list = list.filter(function (o) { return !o.description || !o.description.trim(); }); }
    var originalOrder = {};
    allOutfits.forEach(function (o, idx) { if (o && o.id) originalOrder[o.id] = idx; });
    list = list.slice().sort(function (a, b) {
        var af = a && a.favorite ? 1 : 0;
        var bf = b && b.favorite ? 1 : 0;
        if (af !== bf) return bf - af;
        return (originalOrder[a.id] || 0) - (originalOrder[b.id] || 0);
    });
    var imgOutfits = list.filter(function (o) { return !!o.imageData; });

    // 批量操作栏
    var batchArea = document.getElementById('om-batch-area');
    if (batchArea) {
        if (state.batchMode) {
            batchArea.style.display = '';
            batchArea.innerHTML = '<div class="om-batch-bar">' +
                '<span class="om-batch-info">已选&nbsp;<b id="om-batch-count">' + state.batchSelected.length + '</b>&nbsp;套</span>' +
                '<div class="om-batch-divider" style="width:1px;height:16px;background:rgba(127,127,127,.25);flex-shrink:0;margin:0 2px;"></div>' +
                '<div class="om-batch-acts">' +
                '<button class="om-batch-btn" id="om-batch-selall">全选</button>' +
                '<button class="om-batch-btn" id="om-batch-none">取消</button>' +
                '<button class="om-batch-btn" id="om-batch-cat"><i class="fa-solid fa-folder"></i> 分类</button>' +
                '<button class="om-batch-btn" id="om-batch-move"><i class="fa-solid fa-arrow-right-arrow-left"></i> 移动</button>' +
                '<button class="om-batch-btn" id="om-batch-tag"><i class="fa-solid fa-tag"></i> 标签</button>' +
                '<button class="om-batch-btn" id="om-batch-aidesc"><i class="fa-solid fa-wand-magic-sparkles"></i> AI描述</button>' +
                '<button class="om-batch-btn danger" id="om-batch-del"><i class="fa-solid fa-trash"></i> 删除</button>' +
                '</div></div>';
        } else {
            batchArea.style.display = 'none';
            batchArea.innerHTML = '';
        }
    }

    var html = '';
    html += '<div class="om-grid">';

    if (!state.batchMode) {
        html += '<div class="om-add-card" id="om-addcard"><i class="fa-solid fa-plus"></i><span>添加穿搭</span></div>';
    }

    if (list.length === 0) {
        var hasFilter = state.filterNoCat || state.filterNoTag || state.filterNoDesc;
        var emptyMsg = state.searchQuery ? '没有匹配「' + esc(state.searchQuery) + '」的穿搭'
            : hasFilter ? '没有符合筛选条件的穿搭'
            : (state.curCat !== '__all__' ? '该分类暂无穿搭' : '还没有穿搭，点击左上角添加');
        html += '</div><div class="om-empty"><i class="fa-solid fa-shirt"></i><span>' + emptyMsg + '</span></div>';
    } else {
        list.forEach(function (o) {
            var on = scene && scene.enabled ? !!(scene.current && scene.current.type === 'saved' && scene.current.id === o.id) : partIsActive(part, o.id);
            var bsel = state.batchSelected.indexOf(o.id) !== -1;
            var checkBox = state.batchMode ? '<div class="om-card-check' + (bsel ? ' checked' : '') + '" data-id="' + o.id + '"><i class="fa-solid fa-check"></i></div>' : '';
            var badge = (on && !state.batchMode) ? '<div class="om-badge-on"><i class="fa-solid fa-check"></i></div>' : '';

            var imgContent = '';
            if (o.imageData) {
                imgContent = '<img class="om-lazy-img" src="' + OM_TRANSPARENT_PIXEL + '" data-outfit-id="' + esc(o.id) + '" alt="' + esc(o.name) + '" loading="lazy" decoding="async" />';
            } else {
                var descPreview = (o.description && o.description.trim()) ? o.description.trim() : '';
                imgContent = '<div class="om-card-noimg">' +
                    '<div class="om-noimg-name">' + esc(o.name) + '</div>' +
                    (descPreview ? '<div class="om-noimg-desc">' + esc(descPreview) + '</div>' : '') +
                    '<i class="fa-regular fa-file-lines om-noimg-icon"></i>' +
                    '</div>';
            }

            var favMark = (!state.batchMode && o.favorite) ? '<div class="om-card-fav-mark" title="已收藏"><i class="fa-solid fa-star"></i></div>' : '';
            var menuBtn = state.batchMode ? '' : '<button class="om-card-menu" data-id="' + o.id + '" title="操作"><i class="fa-solid fa-ellipsis"></i></button>';
            var tagText = (o.sceneTag && o.sceneTag.trim()) ? o.sceneTag.trim() : '';
            html += '<div class="om-card' + (on ? ' on' : '') + (bsel ? ' batch-sel' : '') + (o.imageData ? '' : ' no-img') + '" data-id="' + o.id + '">' +
                '<div class="om-card-img">' +
                checkBox + imgContent + favMark + badge + menuBtn +
                '<span class="om-card-number" title="勾选后可按名称或此编号指定穿搭">穿搭' + outfitNumbers[o.id] + '</span>' +
                '</div>' +
                '<div class="om-card-info">' +
                '<div class="om-card-name">' + esc(o.name) + '</div>' +
                (tagText ? '<div class="om-card-tag">' + esc(tagText) + '</div>' : '') +
                '</div>' +
                '</div>';
        });
        html += '</div>';
    }

    area.innerHTML = html;
    setupGridLazyImages(area);

    // 添加卡点击
    var ac = area.querySelector('#om-addcard');
    if (ac) ac.addEventListener('click', function () {
        var defCat = state.catDrillParent || (state.curCat !== '__all__' ? state.curCat : '');
        var defSub = state.catDrillParent && state.curSubCat ? state.curSubCat : '';
        fn.openEditSheet(null, defCat, defSub);
    });

    // 批量操作
    if (state.batchMode) {
        var selall = batchArea.querySelector('#om-batch-selall');
        var selnone = batchArea.querySelector('#om-batch-none');
        var btagBtn = batchArea.querySelector('#om-batch-tag');
        var bdelBtn = batchArea.querySelector('#om-batch-del');

        if (selall) selall.addEventListener('click', function () { state.batchSelected = list.map(function (o) { return o.id; }); fn.renderGrid(); });
        if (selnone) selnone.addEventListener('click', function () { state.batchSelected = []; fn.renderGrid(); });
        var bcatBtn = batchArea.querySelector('#om-batch-cat');
        if (bcatBtn) bcatBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            var curPart = loadCurrent();
            var cats = curPart.categories || [];
            var catNames = getCatNames(cats);
            if (catNames.length === 0) { toast('还没有分类，请先在设置中添加', true); return; }
            var expandedCats = {};
            function buildBatchCategoryList() {
                var itemsHtml = '';
                cats.forEach(function (catObj, catIdx) {
                    var catName = typeof catObj === 'object' ? catObj.name : catObj;
                    var children = typeof catObj === 'object' ? (catObj.children || []) : [];
                    var n = curPart.outfits.filter(function (o) { return o.category === catName; }).length;
                    var isExpanded = !!expandedCats[catIdx];
                    var chevron = children.length > 0
                        ? '<i class="fa-solid fa-chevron-' + (isExpanded ? 'down' : 'right') + ' om-cat-chevron"></i>'
                        : '<span class="om-cat-chevron-placeholder"></span>';
                    itemsHtml += '<div class="om-cat-item om-bcat-parent" data-idx="' + catIdx + '" data-cat="' + esc(catName) + '" style="cursor:pointer;font-weight:600">' +
                        chevron + '<span class="om-cat-name">' + esc(catName) + '</span><span class="om-cat-count">' + n + '套</span>' +
                        '<button class="om-btn-sm om-bcat-parent-pick" data-cat="' + esc(catName) + '" title="选择父分类"><i class="fa-solid fa-check"></i></button></div>';
                    if (isExpanded) {
                        children.forEach(function (sc) {
                            var sn = curPart.outfits.filter(function (o) { return o.category === catName && o.subCategory === sc; }).length;
                            itemsHtml += '<div class="om-cat-item om-bcat-pick om-cat-child" data-cat="' + esc(catName) + '" data-sub="' + esc(sc) + '" style="cursor:pointer;padding-left:32px;opacity:.85"><span class="om-cat-name"><i class="fa-solid fa-turn-up fa-rotate-90" style="font-size:.6em;opacity:.3;margin-right:6px"></i>' + esc(sc) + '</span><span class="om-cat-count">' + sn + '套</span></div>';
                        });
                    }
                });
                return itemsHtml;
            }
            var catSheet = fn.createSheet([
                '<div class="om-sheet-title"><i class="fa-solid fa-folder"></i>选择分类</div>',
                '<div class="om-hint" style="margin-bottom:10px">为已选 ' + state.batchSelected.length + ' 套穿搭设置分类</div>',
                '<div id="om-bcat-list">' + buildBatchCategoryList() + '</div>',
                '<div class="om-divider"></div>',
                '<div class="om-cat-item" id="om-bcat-auto" style="cursor:pointer"><span class="om-cat-name"><i class="fa-solid fa-wand-magic-sparkles" style="opacity:.55;margin-right:7px"></i>自动分类</span><span class="om-cat-count">AI</span></div>',
                '<div class="om-cat-item" id="om-bcat-clear" style="cursor:pointer;opacity:.6"><span class="om-cat-name">清除分类</span></div>',
            ].join(''));
            function bindBatchCategoryList() {
                var listEl = catSheet.querySelector('#om-bcat-list');
                if (!listEl) return;
                listEl.innerHTML = buildBatchCategoryList();
                listEl.querySelectorAll('.om-bcat-parent').forEach(function (row) {
                    row.addEventListener('click', function () {
                        var idx = parseInt(row.dataset.idx);
                        var catObj = cats[idx];
                        var children = typeof catObj === 'object' ? (catObj.children || []) : [];
                        if (children.length > 0) {
                            expandedCats[idx] = !expandedCats[idx];
                            bindBatchCategoryList();
                            return;
                        }
                        applyBatchCategory(row.dataset.cat, '');
                    });
                });
                listEl.querySelectorAll('.om-bcat-parent-pick').forEach(function (btn) {
                    btn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        applyBatchCategory(btn.dataset.cat, '');
                    });
                });
                listEl.querySelectorAll('.om-bcat-pick').forEach(function (item) {
                    item.addEventListener('click', function () {
                        applyBatchCategory(item.dataset.cat, item.dataset.sub || '');
                    });
                });
            }
            function applyBatchCategory(targetCat, targetSub) {
                var p2 = loadCurrent();
                p2.outfits.forEach(function (o) {
                    if (state.batchSelected.indexOf(o.id) !== -1) {
                        o.category = targetCat;
                        o.subCategory = targetSub || '';
                    }
                });
                saveCurrent(p2); fn.closeSheet(catSheet);
                var label = targetCat ? (targetSub ? '「' + targetCat + ' > ' + targetSub + '」' : '「' + targetCat + '」') : '清除分类';
                toast('✅ 已将 ' + state.batchSelected.length + ' 套' + (targetCat ? '移到' + label : label));
                state.batchSelected = []; fn.renderGrid();
            }
            var autoCatBtn = catSheet.querySelector('#om-bcat-auto');
            if (autoCatBtn) autoCatBtn.addEventListener('click', function () {
                var ids = state.batchSelected.slice();
                fn.closeSheet(catSheet);
                openAutoClassifyModal(ids);
            });
            bindBatchCategoryList();
            var clearCatBtn = catSheet.querySelector('#om-bcat-clear');
            if (clearCatBtn) clearCatBtn.addEventListener('click', function () { applyBatchCategory('', ''); });
        });
        if (btagBtn) btagBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            fn.openBatchTagPanel(state.batchSelected.slice(), function () {
                state.batchSelected = []; fn.renderGrid();
            });
        });
        var bmoveBtn = batchArea.querySelector('#om-batch-move');
        if (bmoveBtn) bmoveBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            fn.openMoveToPanel(state.batchSelected.slice(), function () {
                state.batchSelected = []; state.batchMode = false;
                fn.renderViewbar(); fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
            });
        });
        if (bdelBtn) bdelBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            if (!confirm('确定删除已选 ' + state.batchSelected.length + ' 套穿搭？')) return;
            if (state.kitFocusPartKey === currentPartKey() && state.batchSelected.indexOf(state.kitFocusOutfitId) !== -1) clearKitDraft();
            var curP = loadCurrent();
            curP.outfits = curP.outfits.filter(function (o) { return state.batchSelected.indexOf(o.id) === -1; });
            curP.activeIds = (curP.activeIds || []).filter(function (id) { return state.batchSelected.indexOf(id) === -1; });
            saveCurrent(curP);
            syncActivePartitions(currentPartKey(), curP.activeIds);
            fn.updateBtn(); renderBottomStatus(); toast('已删除 ' + state.batchSelected.length + ' 套穿搭'); state.batchSelected = []; fn.renderGrid();
        });

        var baidescBtn = batchArea.querySelector('#om-batch-aidesc');
        if (baidescBtn) baidescBtn.addEventListener('click', function () {
            if (state.batchSelected.length === 0) { toast('请先选择穿搭', true); return; }
            var m = loadMeta();
            if (!m.apiVision.endpoint || !m.apiVision.key || !m.apiVision.model) {
                toast('请先在设置中配置"描述生成 API"', true); return;
            }
            var curP = loadCurrent();
            var hasImg = state.batchSelected.some(function (id) { var o = partGetById(curP, id); return o && o.imageData; });
            if (!hasImg) { toast('所选穿搭中没有带图片的', true); return; }
            fn.openBatchDescModal(state.batchSelected.slice());
        });

        area.querySelectorAll('.om-card').forEach(function (card) {
            card.addEventListener('click', function (e) {
                if (e.target.closest('.om-card-check')) return;
                var id = card.dataset.id;
                var chk = card.querySelector('.om-card-check');
                var idx = state.batchSelected.indexOf(id);
                if (idx !== -1) state.batchSelected.splice(idx, 1); else state.batchSelected.push(id);
                if (chk) chk.classList.toggle('checked', state.batchSelected.indexOf(id) !== -1);
                card.classList.toggle('batch-sel', state.batchSelected.indexOf(id) !== -1);
                var cnt = document.getElementById('om-batch-count');
                if (cnt) cnt.textContent = state.batchSelected.length;
            });
        });
        area.querySelectorAll('.om-card-check').forEach(function (chk) {
            chk.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = chk.dataset.id;
                var idx = state.batchSelected.indexOf(id);
                if (idx !== -1) state.batchSelected.splice(idx, 1); else state.batchSelected.push(id);
                chk.classList.toggle('checked', state.batchSelected.indexOf(id) !== -1);
                var card = chk.closest('.om-card');
                if (card) card.classList.toggle('batch-sel', state.batchSelected.indexOf(id) !== -1);
                var cnt = document.getElementById('om-batch-count');
                if (cnt) cnt.textContent = state.batchSelected.length;
            });
        });
    } else {
        // 非批量：单击 = 选择/取消
        area.querySelectorAll('.om-card').forEach(function (card) {
            var id = card.dataset.id;

            card.addEventListener('click', function (e) {
                if (e.target.closest('.om-card-menu') || e.target.closest('.om-badge-on')) return;
                if (scene && scene.enabled) { toast('场景模式中请通过分类菜单换装，或退出场景模式后手动勾选'); return; }
                var curP = loadCurrent();
                var aids = curP.activeIds || [];
                var idx = aids.indexOf(id);
                if (idx !== -1) aids.splice(idx, 1); else aids.push(id);
                curP.activeIds = aids;
                if (idx !== -1 && isCurrentKitFocus(currentPartKey(), id)) clearKitDraft();

                // 通用衣柜 ↔ 单人衣柜互斥
                var m = loadMeta();
                if (m.currentView === 'char' && idx === -1) {
                    if (m.currentChar === SHARED_CHAR_KEY) {
                        // 在通用衣柜激活 → 清空所有单人衣柜
                        (m.charIndex || []).forEach(function (ci) {
                            if (ci.id !== SHARED_CHAR_KEY) {
                                var cp = loadPartition(ci.partKey);
                                if (cp.activeIds && cp.activeIds.length > 0) {
                                    cp.activeIds = [];
                                    savePartition(ci.partKey, cp);
                                    syncActivePartitions(ci.partKey, []);
                                }
                            }
                        });
                    } else {
                        // 在单人衣柜激活 → 清空通用衣柜
                        var sharedPK = 'char:' + SHARED_CHAR_KEY;
                        var sp = loadPartition(sharedPK);
                        if (sp.activeIds && sp.activeIds.length > 0) {
                            sp.activeIds = [];
                            savePartition(sharedPK, sp);
                            syncActivePartitions(sharedPK, []);
                        }
                    }
                }

                saveCurrent(curP);
                syncActivePartitions(currentPartKey(), aids);
                if (idx === -1 && state.accMode) fn.outfitsInternalEnsureKitFocusForAccMode(false);
                fn.updateBtn(); renderBottomStatus();
                preResolveActiveImages();

                // 更新卡片样式
                var nowActive = partIsActive(curP, id);
                card.classList.toggle('on', nowActive);
                var badge = card.querySelector('.om-badge-on');
                if (nowActive) {
                    if (!badge) { var b = document.createElement('div'); b.className = 'om-badge-on'; b.innerHTML = '<i class="fa-solid fa-check"></i>'; card.querySelector('.om-card-img').appendChild(b); }
                } else {
                    if (badge) badge.parentNode.removeChild(badge);
                }
                closeDetailPanel();
                var n = aids.length;
                var o = partGetById(curP, id);
                if (idx !== -1) toast('已取消：' + (o ? o.name : ''));
                else if (n === 1) toast('✅ 已选：' + (o ? o.name : ''));
                else toast('✅ 衣柜模式，共' + n + '套');
            });
        });

        // 菜单按钮
        area.querySelectorAll('.om-card-menu').forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                var id = btn.dataset.id;
                var o = partGetById(loadCurrent(), id);
                fn.openContextMenu(o, imgOutfits);
            });
        });
    }
}

// ── 底栏状态（使用 loadActivePartitions 跨分包显示）────────
export function renderBottomStatus() {
    var el = document.getElementById('om-bottom-status'); if (!el) return;
    var scene = sceneEntry(currentPartKey());
    if (scene && scene.enabled) {
        var current = scene.current;
        var outfit = current && current.type === 'saved' ? partGetById(loadCurrent(), current.id) : null;
        var label = outfit ? outfit.name : current && current.type === 'temporary' ? '临时日常穿搭' : '沿用剧情穿着';
        el.innerHTML = '<div class="om-status-dot green"></div><span class="om-status-text">🎲 ' + esc(label) + '</span>';
        return;
    }
    var meta = loadMeta();
    var activeParts = loadActivePartitions();

    var allActive = [];
    var curUserPK = currentUserPartKey();

    for (var pk in activeParts) {
        var ap = activeParts[pk];
        var ownerName;
        if (pk.indexOf('user:') === 0) {
            ownerName = 'User';
        } else if (pk === 'char:' + SHARED_CHAR_KEY) {
            ownerName = SHARED_CHAR_KEY;
        } else {
            var cid = pk.substring(5);
            ownerName = charNameById(cid) || cid;
        }
        (ap.activeIds || []).forEach(function (id) {
            var o = partGetById(ap, id);
            if (o) allActive.push({ owner: ownerName, name: o.name, id: id, partKey: pk });
        });
    }

    var dotClass, text;
    if (allActive.length === 0) { dotClass = 'gray'; text = '未选择穿搭'; }
    else {
        dotClass = 'green';
        var parts = [];
        var userCount = allActive.filter(function (a) { return a.owner === 'User'; }).length;
        if (userCount > 0) parts.push('User ' + userCount + '套');
        var charCounts = {};
        allActive.forEach(function (a) {
            if (a.owner !== 'User') {
                var label = a.owner === SHARED_CHAR_KEY ? '通用' : a.owner;
                charCounts[label] = (charCounts[label] || 0) + 1;
            }
        });
        for (var cl in charCounts) { parts.push(cl + ' ' + charCounts[cl] + '套'); }
        text = parts.join(' · ');
        if (allActive.length > 1) dotClass = 'orange';
    }

    var clearBtn = allActive.length > 0 ? '<button class="om-status-clear" id="om-status-clearall">全部取消</button>' : '';
    el.innerHTML = '<div class="om-status-dot ' + dotClass + '"></div><span class="om-status-text">' + esc(text) + '</span>' + clearBtn;

    var clr = el.querySelector('#om-status-clearall');
    if (clr) clr.addEventListener('click', function (e) {
        e.stopPropagation();
        // 清空所有 partition 的 activeIds
        var ap2 = loadActivePartitions();
        for (var pk2 in ap2) {
            ap2[pk2].activeIds = [];
            savePartition(pk2, ap2[pk2]);
            syncActivePartitions(pk2, []);
        }
        clearKitDraft();
        fn.updateBtn(); renderBottomStatus(); fn.renderGrid(); closeDetailPanel();
        toast('已取消全部选择');
    });
}

// ── 选择详情面板 ─────────────────────────────────────────
export function buildDetailGroups() {
    var activeParts = loadActivePartitions();
    var groups = [];
    for (var pk in activeParts) {
        var ap = activeParts[pk];
        var ownerName;
        if (pk.indexOf('user:') === 0) ownerName = 'User';
        else if (pk === 'char:' + SHARED_CHAR_KEY) ownerName = '通用';
        else { var cid = pk.substring(5); ownerName = charNameById(cid) || cid; }

        var items = [];
        (ap.activeIds || []).forEach(function (id) {
            var o = partGetById(ap, id);
            if (o) items.push({ id: id, name: o.name, partKey: pk, outfit: o });
        });
        if (items.length > 0) groups.push({ owner: ownerName, partKey: pk, part: ap, items: items });
    }
    return groups;
}

export function refreshDetailPanel() {
    if (!detailPanelOpen) return;
    var groups = buildDetailGroups();
    if (groups.length === 0) { closeDetailPanel(); return; }
    openDetailPanel(groups);
}

export function toggleDetailPanel() {
    if (detailPanelOpen) { closeDetailPanel(); return; }
    var groups = buildDetailGroups();
    if (groups.length === 0) return;
    openDetailPanel(groups);
}

export function openDetailPanel(groups) {
    closeDetailPanel();
    var bottombar = document.getElementById('om-bottombar'); if (!bottombar) return;
    detailPanelOpen = true;
    var panel = document.createElement('div');
    panel.id = 'om-detail-panel';
    panel.className = 'om-detail-panel';
    panel.style.cssText = 'position:absolute;bottom:100%;left:0;right:0;z-index:10;';

    var html = '<div class="om-detail-handle"></div>';
    var curPK = currentPartKey();
    groups.forEach(function (g) {
        html += '<div class="om-detail-title" style="margin-top:4px">' + esc(g.owner) + '</div>';
        var looseHtml = '';
        var rowHtml = '';
        g.items.forEach(function (w) {
            ensureOutfitKits(w.outfit);
            var focused = isCurrentKitFocus(w.partKey, w.id);
            var useDraft = state.accMode && focused && w.partKey === curPK;
            var kit = getActiveKit(w.outfit);
            var accs = [];
            if (useDraft) {
                (state.kitDraftAccIds || []).forEach(function (aid) {
                    var draftAcc = partGetAccById(g.part, aid);
                    if (draftAcc) accs.push(draftAcc);
                });
            } else if (kit) {
                accs = getKitAccessories(g.part, kit);
            }

            var subjectTag = '<span class="om-detail-tag om-subject-tag' + (focused ? ' focus' : '') + '" data-focus-id="' + esc(w.id) + '" data-pk="' + esc(w.partKey) + '">' +
                esc(w.name) + '<button class="om-detail-tag-x" data-id="' + esc(w.id) + '" data-pk="' + esc(w.partKey) + '">&#x2715;</button></span>';

            if (useDraft || (kit && accs.length > 0)) {
                rowHtml += '<div class="om-kit-row' + (focused ? ' focus' : '') + '">' + subjectTag + '<div class="om-kit-accs-scroll">';
                accs.forEach(function (acc) {
                    var disabled = !useDraft && kit && Array.isArray(kit.disabledAccIds) && kit.disabledAccIds.indexOf(acc.id) !== -1;
                    rowHtml += '<button class="om-kit-acc-tag' + (disabled ? ' disabled' : '') + '" data-pk="' + esc(w.partKey) + '" data-outfit-id="' + esc(w.id) + '" data-acc-id="' + esc(acc.id) + '" data-draft="' + (useDraft ? '1' : '0') + '">' + esc(acc.name) + '</button>';
                });
                rowHtml += '</div>';
                if (useDraft) rowHtml += '<button class="om-kit-save" data-save-kit="1">保存套装</button>';
                rowHtml += '</div>';
            } else {
                looseHtml += subjectTag;
            }
        });
        if (looseHtml) html += '<div class="om-detail-loose-row">' + looseHtml + '</div>';
        if (looseHtml && rowHtml) html += '<div class="om-detail-divider"></div>';
        if (rowHtml) html += '<div class="om-kit-rows">' + rowHtml + '</div>';
    });
    panel.innerHTML = html;
    bottombar.appendChild(panel);
    panel.querySelectorAll('.om-detail-tag-x').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var id = btn.dataset.id;
            var pk = btn.dataset.pk;
            var targetPart = loadPartition(pk);
            var ai = (targetPart.activeIds || []).indexOf(id);
            if (ai !== -1) targetPart.activeIds.splice(ai, 1);
            if (isCurrentKitFocus(pk, id)) clearKitDraft();
            savePartition(pk, targetPart);
            syncActivePartitions(pk, targetPart.activeIds);
            fn.updateBtn(); renderBottomStatus(); fn.renderGrid();
            preResolveActiveImages();
            closeDetailPanel();
        });
    });
    panel.querySelectorAll('.om-subject-tag').forEach(function (tag) {
        tag.addEventListener('click', function (e) {
            if (e.target.closest('.om-detail-tag-x')) return;
            if (!state.accMode) return;
            var pk = tag.dataset.pk;
            var id = tag.dataset.focusId;
            if (pk !== currentPartKey()) { toast('只能为当前衣柜搭配单品', true); return; }
            if (setKitFocus(pk, id)) {
                fn.renderGrid();
                refreshDetailPanel();
            }
        });
    });
    panel.querySelectorAll('.om-kit-acc-tag').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            var accId = btn.dataset.accId;
            if (btn.dataset.draft === '1') fn.toggleDraftAcc(accId);
            else fn.outfitsInternalToggleDisabledAcc(btn.dataset.pk, btn.dataset.outfitId, accId);
        });
    });
    panel.querySelectorAll('[data-save-kit]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            fn.outfitsInternalSaveFocusedKitDraft();
        });
    });
    setTimeout(function () {
        document.addEventListener('click', outsideDetailClick, true);
    }, 10);
}

function outsideDetailClick(e) {
    var panel = document.getElementById('om-detail-panel');
    var statusEl = document.getElementById('om-bottom-status');
    if (panel && !panel.contains(e.target) && statusEl && !statusEl.contains(e.target)) {
        closeDetailPanel();
    }
}

export function closeDetailPanel() {
    detailPanelOpen = false;
    var p = document.getElementById('om-detail-panel'); if (p && p.parentNode) p.parentNode.removeChild(p);
    document.removeEventListener('click', outsideDetailClick, true);
}
