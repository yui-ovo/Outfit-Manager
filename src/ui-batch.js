// ── 穿搭管理器 · 批量操作与导入导出 ──────────────────────
// 批量标签、批量导入、批量AI生成、数据导出导入

import { load, save, loadMeta, loadCurrent, saveCurrent, loadPartition, savePartition, currentPartKey, currentUserPartKey, syncActivePartitions, charIdByName, isServerMode, batchResolveImages, uploadImage, getImageUrlPrefix } from './db.js';
import { getCharData, getViewOutfits, getViewCategories, getById, getCatNames, getSubCats, partGetById, partGetAccById, cleanAccIdFromKits, SHARED_CHAR_KEY, SHARED_CHAR_LABEL } from './data.js';
import { genId, esc, toast, getPopupLayer, compressImage } from './utils.js';
import { batchGenerateDescriptions, batchGenerateAccDescriptions, classifyOutfitImage } from './api.js';
import { state, fn } from './bridge.js';
import { readImportJson, shrinkImportImage, checkImportCancelled } from './import-json.js';
import { importWardrobes } from './import-data.js';

// 需要从 ui-sheets.js 引入的通用函数
var createSheet, closeSheet, getAllTagSuggestions;

export function initBatchDeps(cs, cls, gats) {
    createSheet = cs;
    closeSheet = cls;
    getAllTagSuggestions = gats;
}

function ensurePartArrays(part) {
    if (!part) return;
    if (!Array.isArray(part.outfits)) part.outfits = [];
    if (!Array.isArray(part.categories)) part.categories = [];
    if (!Array.isArray(part.activeIds)) part.activeIds = [];
    if (!Array.isArray(part.accessories)) part.accessories = [];
    if (!Array.isArray(part.accCategories)) part.accCategories = [];
}

function applyUserPartitionToExport(data) {
    var userPart = loadPartition(currentUserPartKey());
    ensurePartArrays(userPart);
    data.outfits = userPart.outfits;
    data.categories = userPart.categories;
    data.activeIds = userPart.activeIds;
    data.accessories = userPart.accessories;
    data.accCategories = userPart.accCategories;
    return data;
}

function getImportCharNames(imported) {
    var names = (imported && Array.isArray(imported.charNames) && imported.charNames.length > 0)
        ? imported.charNames
        : Object.keys((imported && imported.chars) || {});
    var result = [];
    (names || []).forEach(function (cn) {
        if (!cn || cn === SHARED_CHAR_KEY || result.indexOf(cn) !== -1) return;
        result.push(cn);
    });
    return result;
}

function getOutfitMoveTarget(targetType, targetChar, presetIdx) {
    var info = { partKey: '', label: 'User', isPreset: false };
    if (targetType === 'user') {
        info.partKey = currentUserPartKey();
        return info;
    }
    if (targetType === 'char' && targetChar) {
        if (targetChar === SHARED_CHAR_KEY) {
            info.partKey = 'char:' + SHARED_CHAR_KEY;
            info.label = SHARED_CHAR_LABEL;
            return info;
        }
        var cid = charIdByName(targetChar);
        if (cid) {
            info.partKey = 'char:' + cid;
            info.label = targetChar;
        }
        return info;
    }
    if (targetType === 'preset') {
        var meta = loadMeta();
        var p = (meta.presets || [])[presetIdx];
        if (p) {
            info.partKey = p.partKey;
            info.label = p.name || '预设';
            info.isPreset = true;
        }
    }
    return info;
}

function clearOutfitKits(outfit) {
    if (!outfit) return outfit;
    outfit.kits = [];
    outfit.activeKitId = null;
    return outfit;
}

// ── 批量标签选择面板 ──────────────────────────────────────
function openBatchTagPanel(selectedIds, onDone) {
    var d = load();
    var tags = getAllTagSuggestions(d);
    var allOutfits = getViewOutfits(d);
    var count = selectedIds.length;

    function countTag(tag) {
        var n = 0;
        allOutfits.forEach(function (o) { if (o.sceneTag && o.sceneTag.trim() === tag) n++; });
        return n;
    }

    var sheet = createSheet([
        '<div class="om-sheet-title"><i class="fa-solid fa-tags"></i>设置场景标签</div>',
        '<div class="om-hint" style="margin-bottom:10px">为已选 ' + count + ' 套穿搭设置标签</div>',
        '<div class="om-tagpanel">',
        '<input type="text" class="om-tagpanel-search" id="om-btag-search" placeholder="搜索标签…" autocomplete="off" />',
        '<div class="om-tagpanel-list" id="om-btag-list"></div>',
        '<div class="om-tagpanel-add"><input type="text" id="om-btag-new" placeholder="输入新标签并应用…" /><button class="om-btn om-btn-safe" id="om-btag-apply">应用</button></div>',
        '<div class="om-divider" style="margin:6px 0"></div>',
        '<button class="om-btn om-btn-outline" id="om-btag-clear" style="width:100%;opacity:.6"><i class="fa-solid fa-eraser"></i> 清除所选穿搭的标签</button>',
        '</div>',
    ].join(''));

    var listEl = sheet.querySelector('#om-btag-list');
    var searchInp = sheet.querySelector('#om-btag-search');

    function renderList(filter) {
        var q = (filter || '').trim().toLowerCase();
        var filtered = q ? tags.filter(function (t) { return t.toLowerCase().indexOf(q) !== -1; }) : tags;

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="om-tagpanel-empty">' + (q ? '没有匹配的标签' : '还没有标签') + '</div>';
            return;
        }

        listEl.innerHTML = filtered.map(function (tag) {
            return '<div class="om-cat-item om-btag-pick" data-tag="' + esc(tag) + '" style="cursor:pointer"><span class="om-cat-name">' + esc(tag) + '</span><span class="om-cat-count">' + countTag(tag) + '套</span></div>';
        }).join('');

        listEl.querySelectorAll('.om-btag-pick').forEach(function (item) {
            item.addEventListener('click', function () {
                applyTag(item.dataset.tag);
            });
        });
    }

    function applyTag(tag) {
        var curP = loadCurrent();
        curP.outfits.forEach(function (o) { if (selectedIds.indexOf(o.id) !== -1) o.sceneTag = tag; });
        saveCurrent(curP); closeSheet(sheet);
        toast('✅ 已设置标签：' + tag);
        if (onDone) onDone();
    }

    renderList('');
    searchInp.addEventListener('input', function () { renderList(this.value); });
    setTimeout(function () { searchInp.focus(); }, 100);

    // 输入新标签并直接应用
    var newInp = sheet.querySelector('#om-btag-new');
    sheet.querySelector('#om-btag-apply').addEventListener('click', function () {
        var tag = newInp.value.trim();
        if (!tag) { toast('请输入标签', true); return; }
        applyTag(tag);
    });
    newInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') sheet.querySelector('#om-btag-apply').click(); });

    // 清除标签
    sheet.querySelector('#om-btag-clear').addEventListener('click', function () {
        var curP = loadCurrent();
        curP.outfits.forEach(function (o) { if (selectedIds.indexOf(o.id) !== -1) o.sceneTag = ''; });
        saveCurrent(curP); closeSheet(sheet);
        toast('✅ 已清除 ' + count + ' 套穿搭的标签');
        if (onDone) onDone();
    });
}

// ── 导出 ──────────────────────────────────────────────────
function doExportFile(data, filename) {
    try {
        var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 500);
    } catch (e) { toast('导出失败：' + e.message, true); }
}

// 收集数据中所有后端图片 URL
function collectImageUrls(data) {
    var urls = [];
    var prefix = getImageUrlPrefix();
    function scanImageItems(items) {
        if (!Array.isArray(items)) return;
        items.forEach(function (item) {
            if (item && typeof item.imageData === 'string' && item.imageData.indexOf(prefix) === 0) {
                urls.push(item.imageData);
            }
        });
    }
    function scanPartition(part) {
        if (!part) return;
        scanImageItems(part.outfits);
        scanImageItems(part.accessories);
    }
    scanPartition(data);
    if (data.chars) {
        for (var cn in data.chars) { scanPartition(data.chars[cn]); }
    }
    if (Array.isArray(data.presets)) {
        data.presets.forEach(function (p) { scanPartition(p); });
    }
    if (typeof data.fabImage === 'string' && data.fabImage.indexOf(prefix) === 0) {
        urls.push(data.fabImage);
    }
    return urls;
}

function doExport(data, filename) {
    if (!isServerMode()) {
        doExportFile(data, filename);
        return;
    }
    // Server 模式：收集图片 URL → 批量取 base64 → 附加 _assets
    var urls = collectImageUrls(data);
    if (urls.length === 0) {
        doExportFile(data, filename);
        return;
    }
    toast('📦 正在打包图片…');
    batchResolveImages(urls, function (imageMap) {
        var assets = {};
        var prefix = getImageUrlPrefix();
        for (var url in imageMap) {
            var dataUrl = imageMap[url];
            if (dataUrl && dataUrl.indexOf('data:image/') === 0) {
                var name = url.replace(prefix, '');
                if (name && !assets[name]) assets[name] = dataUrl;
            }
        }
        var exportData = JSON.parse(JSON.stringify(data));
        if (Object.keys(assets).length > 0) exportData._assets = assets;
        doExportFile(exportData, filename);
        toast('✅ 导出完成（含 ' + Object.keys(assets).length + ' 张图片）');
    });
}

function exportData() {
    var d = load();
    var isCharView = d.currentView === 'char' && d.currentChar;
    var modal = document.createElement('div');
    modal.className = 'om-modal ' + (state.darkMode ? 'om-dark' : 'om-light');
    modal.style.setProperty('z-index', '2147483647', 'important');

    var charBtns = '';
    if (isCharView) {
        charBtns =
            '<button class="om-modal-btn" id="om-exp-char-one"><i class="fa-solid fa-user" style="margin-right:8px"></i>导出「' + esc(d.currentChar) + '」<br><small style="opacity:.6;font-weight:400">当前角色的穿搭+分类</small></button>';
    }
    if (d.charNames && d.charNames.length > 0) {
        charBtns +=
            '<button class="om-modal-btn" id="om-exp-char-all"><i class="fa-solid fa-users" style="margin-right:8px"></i>导出全部角色<br><small style="opacity:.6;font-weight:400">所有角色的穿搭+分类</small></button>';
    }

    modal.innerHTML = '<div class="om-modal-box">' +
        '<div class="om-modal-title"><i class="fa-solid fa-download" style="margin-right:6px"></i>导出数据</div>' +
        '<button class="om-modal-btn" id="om-exp-all"><i class="fa-solid fa-database" style="margin-right:8px"></i>导出完整备份<br><small style="opacity:.6;font-weight:400">User+角色+预设+设置</small></button>' +
        '<button class="om-modal-btn" id="om-exp-user"><i class="fa-solid fa-shirt" style="margin-right:8px"></i>仅导出 User 穿搭<br><small style="opacity:.6;font-weight:400">User的穿搭+分类</small></button>' +
        charBtns +
        '<button class="om-modal-cancel" id="om-exp-cancel">取消</button></div>';
    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal) _mp.removeChild(modal); });
    modal.querySelector('#om-exp-cancel').addEventListener('click', function () { _mp.removeChild(modal); });

    document.getElementById('om-exp-all').addEventListener('click', function () {
        _mp.removeChild(modal);
        doExport(applyUserPartitionToExport(d), 'outfit-mgr-backup-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出完整数据');
    });

    document.getElementById('om-exp-user').addEventListener('click', function () {
        _mp.removeChild(modal);
        var userExport = applyUserPartitionToExport({ type: 'user' });
        doExport(userExport, 'outfit-mgr-user-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出 User 穿搭');
    });

    var expCharOne = document.getElementById('om-exp-char-one');
    if (expCharOne) expCharOne.addEventListener('click', function () {
        _mp.removeChild(modal);
        var cd = getCharData(d, d.currentChar);
        doExport({ type: 'char', charName: d.currentChar, outfits: cd.outfits, categories: cd.categories, accessories: cd.accessories || [], accCategories: cd.accCategories || [] }, 'outfit-mgr-char-' + d.currentChar + '-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出「' + d.currentChar + '」');
    });

    var expCharAll = document.getElementById('om-exp-char-all');
    if (expCharAll) expCharAll.addEventListener('click', function () {
        _mp.removeChild(modal);
        var exportCharNames = getImportCharNames({ charNames: d.charNames || [], chars: d.chars || {} });
        var charExport = { type: 'chars_all', charNames: exportCharNames, chars: {} };
        exportCharNames.forEach(function (cn) { charExport.chars[cn] = getCharData(d, cn); });
        if (d.chars && d.chars[SHARED_CHAR_KEY]) {
            var sc = d.chars[SHARED_CHAR_KEY];
            charExport.chars[SHARED_CHAR_KEY] = {
                outfits: sc.outfits || [],
                categories: sc.categories || [],
                activeIds: sc.activeIds || [],
                accessories: sc.accessories || [],
                accCategories: sc.accCategories || []
            };
        }
        doExport(charExport, 'outfit-mgr-all-chars-' + new Date().toISOString().slice(0, 10) + '.json');
        toast('✅ 已导出全部角色（' + exportCharNames.length + '个）');
    });
}

var dataImportRunning = false;

function refreshAfterImport() {
    fn.renderViewbar(); fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
}

function importData() {
    if (dataImportRunning) { toast('已有导入正在进行，请等待完成或取消'); return; }
    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.innerHTML = '<div class="om-modal-box">' +
        '<div class="om-modal-title"><i class="fa-solid fa-upload" style="margin-right:6px"></i>分批导入数据</div>' +
        '<div class="om-hint" style="margin-bottom:10px">选择 .json 文件。分块读取，每 20 项分批处理，按衣柜保存。</div>' +
        '<label style="display:flex;gap:8px;align-items:flex-start;margin-bottom:12px;font-size:.82em"><input type="checkbox" id="om-imp-compress" />压缩静态图片（手机大文件推荐；最长边 1280，PNG 保留透明，GIF 保留原图）</label>' +
        '<button class="om-modal-btn" id="om-imp-merge">合并导入<br><small>追加到现有数据，不覆盖</small></button>' +
        '<button class="om-modal-btn" id="om-imp-update">替换同名<br><small>同名穿搭更新，其余追加</small></button>' +
        '<button class="om-modal-btn" id="om-imp-replace">覆盖导入<br><small>替换对应衣柜的穿搭，现有预设保留</small></button>' +
        '<input type="file" id="om-imp-file" accept=".json" style="display:none" />' +
        '<div id="om-imp-progress" role="status" aria-live="polite" style="font-size:.82em;white-space:pre-wrap;overflow-wrap:anywhere"></div>' +
        '<progress id="om-imp-bar" max="100" value="0" style="display:none;width:100%;margin-top:10px"></progress>' +
        '<button class="om-modal-cancel" id="om-imp-cancel">取消</button></div>';
    var layer = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    layer.appendChild(modal);
    var fileInp = modal.querySelector('#om-imp-file');
    var status = modal.querySelector('#om-imp-progress');
    var bar = modal.querySelector('#om-imp-bar');
    var cancel = modal.querySelector('#om-imp-cancel');
    var compress = modal.querySelector('#om-imp-compress');
    var buttons = Array.from(modal.querySelectorAll('.om-modal-btn'));
    var importMode = 'merge', controller = null, running = false, finished = false;
    function close() { if (modal.parentNode) modal.parentNode.removeChild(modal); }
    modal.addEventListener('click', function (e) { if (e.target === modal && !running) close(); });
    cancel.addEventListener('click', function () {
        if (!running) { close(); return; }
        controller.abort();
        cancel.disabled = true;
        status.textContent = '正在停止，请等待当前图片或保存操作结束…';
    });
    ['merge', 'update', 'replace'].forEach(function (mode) {
        modal.querySelector('#om-imp-' + mode).addEventListener('click', function () {
            if (running || finished) return;
            importMode = mode; fileInp.click();
        });
    });
    fileInp.addEventListener('change', async function () {
        var file = fileInp.files[0];
        if (!file || running || dataImportRunning) return;
        running = dataImportRunning = true;
        controller = new AbortController();
        var userKey = currentUserPartKey();
        buttons.forEach(function (button) { button.disabled = true; });
        compress.disabled = true;
        cancel.textContent = '取消导入';
        bar.style.display = '';
        status.textContent = '准备分块读取（' + (file.size / 1024 / 1024).toFixed(1) + ' MB）…';
        var saved = 0, imageCount = 0;
        try {
            var imported = await readImportJson(file, {
                signal: controller.signal,
                transformImage: compress.checked ? async function (value) {
                    checkImportCancelled(controller.signal);
                    status.textContent = '正在压缩第 ' + (++imageCount) + ' 张图片…';
                    return shrinkImportImage(value);
                } : null,
                onProgress: function (done, total) {
                    bar.value = total ? done / total * 100 : 0;
                    status.textContent = '正在分块读取：' + Math.floor(bar.value) + '%';
                }
            });
            bar.removeAttribute('value');
            var result = await importWardrobes(imported, importMode, {
                signal: controller.signal, userKey: userKey,
                onProgress: function (progress) {
                    saved = progress.completed;
                    status.textContent = progress.phase === 'items'
                        ? '正在处理「' + progress.name + '」：' + progress.done + '/' + progress.total + ' 项'
                        : (progress.phase === 'saving' ? '正在保存「' : '已保存「') + progress.name + '」';
                }
            });
            saved = result.completedWardrobes;
            bar.value = 100;
            status.textContent = '导入完成，已保存 ' + saved + ' 个衣柜。' + (isServerMode() ? '后端同步由插件继续处理。' : '');
        } catch (error) {
            saved = error.completedWardrobes || saved;
            status.textContent = (error.name === 'AbortError' ? '已取消导入。' : '导入未完成：' + error.message + '。') +
                (saved ? '\n已保存 ' + saved + ' 个衣柜，尚未保存的衣柜保留原数据。再次合并导入同一文件会重复追加。' : '\n未更改原有穿搭数据。');
            bar.value = 0;
        } finally {
            imported = null;
            fileInp.value = '';
            running = dataImportRunning = false;
            finished = true;
            cancel.disabled = false;
            cancel.textContent = '关闭';
            if (saved) refreshAfterImport();
        }
    });
}

async function processImport(imported, mode) {
    try {
        var result = await importWardrobes(imported, mode);
        refreshAfterImport();
        toast('✅ 导入完成：' + result.completedWardrobes + ' 个衣柜');
        return result;
    } catch (error) {
        if (error.completedWardrobes) refreshAfterImport();
        toast('导入未完成：' + error.message, true);
        throw error;
    }
}

// ── 批量导入弹窗 ─────────────────────────────────────────
function openBatchImportModal(files) {
    var targetPartKey = currentPartKey();
    var curPart = loadPartition(targetPartKey);
    var meta = loadMeta();
    var curCat = state.catDrillParent || ((state.curCat && state.curCat !== '__all__') ? state.curCat : '');
    var curSubCat = state.catDrillParent && state.curSubCat ? state.curSubCat : '';
    var viewCats = curPart.categories || [];
    var catNames = getCatNames(viewCats);
    var catOpts = '<option value="">未分类</option>' +
        catNames.map(function (c) { return '<option value="' + esc(c) + '"' + (c === curCat ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var hasApi = !!(meta.apiVision.endpoint && meta.apiVision.key && meta.apiVision.model);
    var classifyHtml = hasApi
        ? (catNames.length > 0
            ? '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-bottom:8px"><input type="checkbox" id="om-bimport-classify" checked /> 自动分类到现有分类</label>'
            : '')
        : '';

    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.innerHTML = '<div class="om-modal-box" style="background:' + (state.darkMode ? '#1e1e24' : '#ececef') + ';color:' + (state.darkMode ? '#eee' : '#111') + ';max-height:80vh">' +
        '<div class="om-modal-title"><i class="fa-solid fa-images" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>批量导入穿搭</div>' +
        '<div style="font-size:.82em;opacity:.7;margin-bottom:8px">已选择 ' + files.length + ' 张图片，将自动压缩</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;max-height:120px;overflow-y:auto;margin-bottom:10px" id="om-bimport-preview"></div>' +
        '<div class="om-field" style="margin-bottom:8px"><label style="font-size:.82em;font-weight:600">导入到分类</label><select id="om-bimport-cat" style="background:rgba(127,127,127,.08);border:1px solid rgba(127,127,127,.2);border-radius:8px;color:inherit;padding:7px 10px;font-size:.85em;width:100%;box-sizing:border-box;font-family:inherit">' + catOpts + '</select></div>' +
        classifyHtml +
        (hasApi ? '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-bottom:10px"><input type="checkbox" id="om-bimport-ai" checked /> 导入后 AI 生成描述和名称</label>' : '<div style="font-size:.78em;opacity:.4;margin-bottom:10px">💡 配置"描述生成 API"后可自动生成描述和名称</div>') +
        '<div id="om-bimport-status" style="display:none;margin:8px 0;font-size:.82em"></div>' +
        '<div class="om-btn-row" style="margin-top:6px" id="om-bimport-actions">' +
        '<button class="om-btn om-btn-safe" id="om-bimport-start"><i class="fa-solid fa-file-import"></i> 开始导入</button>' +
        '<button class="om-btn om-btn-outline" id="om-bimport-close">取消</button></div></div>';

    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);
    modal.addEventListener('click', function (e) { if (e.target === modal && !modal.dataset.running) _mp.removeChild(modal); });
    modal.querySelector('#om-bimport-close').addEventListener('click', function () { if (!modal.dataset.running) _mp.removeChild(modal); });

    var previewEl = modal.querySelector('#om-bimport-preview');
    files.forEach(function (f) {
        var thumb = document.createElement('div');
        thumb.style.cssText = 'width:52px;height:52px;border-radius:6px;overflow:hidden;background:rgba(127,127,127,.1);flex-shrink:0;';
        var reader = new FileReader();
        reader.onload = function (e) {
            thumb.innerHTML = '<img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover" />';
        };
        reader.readAsDataURL(f);
        previewEl.appendChild(thumb);
    });

    modal.querySelector('#om-bimport-start').addEventListener('click', function () {
        modal.dataset.running = '1';
        modal.querySelector('#om-bimport-start').disabled = true;
        modal.querySelector('#om-bimport-start').textContent = '导入中...';
        modal.querySelector('#om-bimport-close').textContent = '请等待...';
        var statusEl = modal.querySelector('#om-bimport-status');
        statusEl.style.display = 'block';

        var cat = modal.querySelector('#om-bimport-cat').value;
        var fallbackClass = { category: cat, subCategory: curSubCat || '' };
        if (fallbackClass.subCategory && getSubCats(viewCats, fallbackClass.category).indexOf(fallbackClass.subCategory) === -1) fallbackClass.subCategory = '';
        var autoClassify = hasApi && catNames.length > 0 && modal.querySelector('#om-bimport-classify') && modal.querySelector('#om-bimport-classify').checked;
        var useAI = hasApi && modal.querySelector('#om-bimport-ai') && modal.querySelector('#om-bimport-ai').checked;
        var imported = 0;
        var newIds = [];
        var importedOutfits = [];
        var classifyFailures = 0;

        function prepareImageForStorage(compressed, idx, cb) {
            if (!isServerMode()) { cb(null, compressed); return; }
            statusEl.textContent = '上传中... ' + (idx + 1) + '/' + files.length;
            uploadImage(compressed, function (err, imageData) {
                if (err || !imageData || imageData.indexOf('data:image/') === 0) {
                    cb('图片上传失败/后端写入失败');
                    return;
                }
                cb(null, imageData);
            });
        }

        var classifyDuringImport = autoClassify && !useAI;

        function classifyImage(compressed, idx, cb) {
            if (!classifyDuringImport) { cb(fallbackClass); return; }
            statusEl.textContent = '自动分类中... ' + (idx + 1) + '/' + files.length;
            classifyOutfitImage(meta.apiVision, { name: '', dataUrl: compressed }, viewCats, fallbackClass, function (err, cls) {
                if (err) classifyFailures++;
                cb(cls || fallbackClass);
            });
        }

        function showImportFailure(msg) {
            var text = msg || '保存失败/空间不足/后端写入失败';
            delete modal.dataset.running;
            statusEl.innerHTML = '<div style="color:#e57373;font-weight:600">' + esc(text) + '</div>';
            toast(text, true);
            modal.querySelector('#om-bimport-start').disabled = false;
            modal.querySelector('#om-bimport-start').textContent = '重新导入';
            modal.querySelector('#om-bimport-close').textContent = '取消';
        }

        function verifyImportedIds(ids) {
            var savedPart = loadPartition(targetPartKey);
            for (var v = 0; v < ids.length; v++) {
                if (!partGetById(savedPart, ids[v])) return false;
            }
            return true;
        }

        function compressNext(i) {
            if (i >= files.length) {
                if (importedOutfits.length > 0) {
                    var finalPart = loadPartition(targetPartKey);
                    if (!Array.isArray(finalPart.outfits)) finalPart.outfits = [];
                    finalPart.outfits = importedOutfits.filter(function (o) { return !!o; }).concat(finalPart.outfits);
                    savePartition(targetPartKey, finalPart);
                    if (!verifyImportedIds(newIds)) {
                        showImportFailure('保存失败/空间不足/后端写入失败');
                        return;
                    }
                } else if (files.length > 0) {
                    showImportFailure('图片读取或上传失败');
                    return;
                }
                delete modal.dataset.running;
                statusEl.innerHTML = '<div style="color:#4caf50;font-weight:600">✅ 已导入 ' + imported + ' 套穿搭' + (classifyDuringImport ? '，已自动分类' : '') + '</div>' +
                    (classifyDuringImport && classifyFailures > 0 ? '<div style="opacity:.55;margin-top:4px">' + classifyFailures + ' 张分类失败，已使用默认分类</div>' : '');
                var actionsEl = modal.querySelector('#om-bimport-actions');
                if (useAI && newIds.length > 0) {
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-bimport-ai-go"><i class="fa-solid fa-wand-magic-sparkles"></i> ' + (autoClassify ? 'AI 生成描述并分类' : 'AI 生成描述') + '</button><button class="om-btn om-btn-outline" id="om-bimport-done">跳过</button>';
                    modal.querySelector('#om-bimport-ai-go').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus();
                        openBatchDescModal(newIds, { autoClassify: autoClassify });
                    });
                    modal.querySelector('#om-bimport-done').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
                    });
                } else {
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-bimport-done">完成</button>';
                    modal.querySelector('#om-bimport-done').addEventListener('click', function () {
                        _mp.removeChild(modal);
                        fn.renderCatbar(); fn.renderGrid(); fn.renderBottomStatus(); fn.updateBtn();
                    });
                }
                return;
            }
            statusEl.textContent = '压缩中... ' + (i + 1) + '/' + files.length;
            var reader = new FileReader();
            reader.onload = function (e) {
                compressImage(e.target.result, function (compressed) {
                    classifyImage(compressed, i, function (cls) {
                        prepareImageForStorage(compressed, i, function (err, imageData) {
                            if (!err) {
                                var id = genId();
                                var newOutfit = {
                                    id: id,
                                    name: '穿搭' + (i + 1),
                                    category: cls.category || '',
                                    subCategory: cls.subCategory || '',
                                    description: '',
                                    sceneTag: '',
                                    imageData: imageData,
                                    favorite: false,
                                    kits: [],
                                    activeKitId: null,
                                    createdAt: Date.now()
                                };
                                importedOutfits[i] = newOutfit;
                                newIds.push(id);
                                imported++;
                            }
                            compressNext(i + 1);
                        });
                    });
                });
            };
            reader.onerror = function () { compressNext(i + 1); };
            reader.readAsDataURL(files[i]);
        }
        compressNext(0);
    });
}

// ── 批量 AI 生成描述弹窗 ──────────────────────────────────
function openBatchDescModal(ids, defaults) {
    defaults = defaults || {};
    var curP = loadCurrent();
    var withImg = ids.filter(function (id) { var o = partGetById(curP, id); return o && o.imageData; });
    var skipCount = ids.length - withImg.length;
    var existingDescCount = withImg.filter(function (id) { var o = partGetById(curP, id); return o && o.description && o.description.trim(); }).length;
    var overwriteDescDefault = defaults.overwriteDescription !== undefined ? !!defaults.overwriteDescription : true;
    var willSkipDesc = overwriteDescDefault ? 0 : existingDescCount;
    var descCallCount = Math.max(0, withImg.length - willSkipDesc);
    var canAutoClassify = getCatNames(curP.categories || []).length > 0;
    var sourcePartKey = currentPartKey();
    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.innerHTML = '<div class="om-modal-box" style="background:' + (state.darkMode ? '#1e1e24' : '#ececef') + ';color:' + (state.darkMode ? '#eee' : '#111') + '">' +
        '<div class="om-modal-title"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>AI 批量生成</div>' +
        '<div style="font-size:.82em;opacity:.7;margin-bottom:8px">' +
        '共选中 ' + ids.length + ' 套，其中 ' + withImg.length + ' 套有图片' +
        (skipCount > 0 ? '，' + skipCount + ' 套无图片将跳过' : '') +
        (existingDescCount > 0 ? '<br><span id="om-batch-skip-desc">' + (overwriteDescDefault ? existingDescCount + ' 套已有描述将重新生成' : existingDescCount + ' 套已有描述将保留不改') + '</span>' : '') +
        '</div>' +
        '<div style="font-size:.78em;opacity:.5;margin-bottom:8px">共需 <span id="om-batch-call-count">' + descCallCount + '</span> 次 API 调用</div>' +
        '<div style="border:1px solid rgba(127,127,127,.12);border-radius:8px;padding:10px;margin-bottom:8px">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer"><input type="checkbox" id="om-batch-overwrite-desc"' + (overwriteDescDefault ? ' checked' : '') + ' /> 重新生成描述（覆盖现有描述）</label>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-top:8px"><input type="checkbox" id="om-batch-autoname" checked /> 同时生成穿搭名称（覆盖现有名称）</label>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-top:8px"><input type="checkbox" id="om-batch-autocat"' + (canAutoClassify ? '' : ' disabled') + (defaults.autoClassify && canAutoClassify ? ' checked' : '') + ' /> 同时自动分类</label>' +
        '</div>' +
        '<div id="om-batch-progress" style="display:none;margin:10px 0">' +
        '<div style="font-size:.82em;margin-bottom:6px" id="om-batch-prog-text">准备中...</div>' +
        '<div style="height:6px;background:rgba(127,127,127,.15);border-radius:3px;overflow:hidden">' +
        '<div id="om-batch-prog-bar" style="height:100%;width:0%;background:var(--SmartThemeQuoteColor,#7c6daf);border-radius:3px;transition:width .3s"></div></div></div>' +
        '<div id="om-batch-result" style="display:none;margin:8px 0;font-size:.82em;max-height:120px;overflow-y:auto"></div>' +
        '<div class="om-btn-row" style="margin-top:10px" id="om-batch-actions">' +
        '<button class="om-btn om-btn-safe" id="om-batch-start"><i class="fa-solid fa-play"></i> 开始生成</button>' +
        '<button class="om-btn om-btn-outline" id="om-batch-close">取消</button></div></div>';

    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);

    var modalAlive = true;
    function removeModal() { if (modalAlive && modal.parentNode) { modal.parentNode.removeChild(modal); modalAlive = false; } }

    modal.addEventListener('click', function (e) { if (e.target === modal) removeModal(); });
    modal.querySelector('#om-batch-close').addEventListener('click', function () { removeModal(); });

    function updateBatchCallCount() {
        var el = modal.querySelector('#om-batch-call-count');
        var autoCatEl = modal.querySelector('#om-batch-autocat');
        var overwriteDescEl = modal.querySelector('#om-batch-overwrite-desc');
        var overwriteDesc = !overwriteDescEl || overwriteDescEl.checked;
        var currentDescCallCount = Math.max(0, withImg.length - (overwriteDesc ? 0 : existingDescCount));
        if (el) el.textContent = (autoCatEl && autoCatEl.checked && !autoCatEl.disabled) ? withImg.length : currentDescCallCount;
        var skipEl = modal.querySelector('#om-batch-skip-desc');
        if (skipEl) skipEl.textContent = overwriteDesc ? existingDescCount + ' 套已有描述将重新生成' : existingDescCount + ' 套已有描述将保留不改';
    }
    var autoCatToggle = modal.querySelector('#om-batch-autocat');
    if (autoCatToggle) autoCatToggle.addEventListener('change', updateBatchCallCount);
    var overwriteDescToggle = modal.querySelector('#om-batch-overwrite-desc');
    if (overwriteDescToggle) overwriteDescToggle.addEventListener('change', updateBatchCallCount);
    updateBatchCallCount();

    modal.querySelector('#om-batch-start').addEventListener('click', function () {
        modal.querySelector('#om-batch-progress').style.display = 'block';
        modal.querySelector('#om-batch-start').disabled = true;
        modal.querySelector('#om-batch-start').textContent = '生成中...';
        var closeBtn = modal.querySelector('#om-batch-close');
        closeBtn.textContent = '后台运行';
        closeBtn.onclick = function () {
            removeModal();
            toast('👗 AI 生成中，可继续使用酒馆，完成后会通知');
        };

        var options = {
            overwriteDescription: modal.querySelector('#om-batch-overwrite-desc').checked,
            autoName: modal.querySelector('#om-batch-autoname').checked,
            autoClassify: modal.querySelector('#om-batch-autocat') && modal.querySelector('#om-batch-autocat').checked && !modal.querySelector('#om-batch-autocat').disabled
        };

        function finishBatch(descDoneCount, descErrors, classDoneCount, classErrors, err, stats) {
            descErrors = descErrors || [];
            classErrors = classErrors || [];
            stats = stats || {};
            var descSuccess = stats.descSuccess !== undefined ? stats.descSuccess : Math.max(0, (descDoneCount || 0) - descErrors.length);
            var classSuccess = stats.classSuccess !== undefined ? stats.classSuccess : Math.max(0, (classDoneCount || 0) - classErrors.length);
            if (modalAlive) {
                var bar = modal.querySelector('#om-batch-prog-bar');
                if (bar) bar.style.width = '100%';
                var resultEl = modal.querySelector('#om-batch-result');
                resultEl.style.display = 'block';
                if (err && !descDoneCount && !classDoneCount) {
                    resultEl.innerHTML = '<div style="color:#e57373"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(err) + '</div>';
                } else {
                    var html2 = '<div style="color:#4caf50;font-weight:600">✅ 描述生成 ' + descSuccess + ' 条</div>';
                if (options.autoClassify) html2 += '<div style="color:#4caf50;font-weight:600;margin-top:4px">✅ 自动分类 ' + classSuccess + ' 套</div>';
                    if (descErrors.length > 0 || classErrors.length > 0) {
                        html2 += '<div style="color:#ff8c42;margin-top:4px">⚠️ ' + (descErrors.length + classErrors.length) + ' 个失败：</div>';
                        descErrors.concat(classErrors).forEach(function (e) {
                            html2 += '<div style="opacity:.6;font-size:.9em;margin-left:8px">· ' + esc(e.name) + '：' + esc(e.error) + '</div>';
                        });
                    }
                    resultEl.innerHTML = html2;
                }
                var actionsEl = modal.querySelector('#om-batch-actions');
                actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-batch-done">完成</button>';
                modal.querySelector('#om-batch-done').addEventListener('click', function () {
                    removeModal();
                    fn.renderCatbar();
                    fn.renderGrid();
                });
            } else {
                var msg = 'AI 批量完成：描述 ' + descSuccess + ' 条';
                if (options.autoClassify) msg += '，分类 ' + classSuccess + ' 套';
                var failCount = descErrors.length + classErrors.length;
                if (failCount > 0) msg += '，失败 ' + failCount + ' 个';
                toast(msg);
                fn.renderCatbar();
                fn.renderGrid();
            }
        }

        function runAutoClassify(descDoneCount, descErrors, descErr, descStats) {
            if (!options.autoClassify) {
                finishBatch(descDoneCount, descErrors, 0, [], descErr, descStats);
                return;
            }
            finishBatch(descDoneCount, descErrors, descStats ? descStats.classTarget : 0, [], descErr, descStats);
        }

        batchGenerateDescriptions(ids, options,
            function (done, total, msg) {
                var pct = total > 0 ? Math.round(done / total * 100) : 0;
                if (modalAlive) {
                    var bar = modal.querySelector('#om-batch-prog-bar');
                    var txt = modal.querySelector('#om-batch-prog-text');
                    if (bar) bar.style.width = pct + '%';
                    if (txt) txt.textContent = '描述 ' + done + '/' + total + ' ' + msg;
                }
            },
            function (err, doneCount, errors, stats) {
                runAutoClassify(doneCount, errors || [], err, stats);
            }
        );
    });
}

// ── 单品批量 AI 生成描述弹窗 ─────────────────────────────
function openAccBatchDescModal(ids) {
    var curP = loadCurrent();
    var missingCat = ids.filter(function (id) {
        var a = partGetAccById(curP, id);
        return a && (!a.category || !a.category.trim());
    }).length;
    if (missingCat > 0) {
        toast('请先为单品选择分类，再批量生成描述和名称', true);
        return;
    }
    var withImg = ids.filter(function (id) { var a = partGetAccById(curP, id); return a && a.imageData; });
    var skipCount = ids.length - withImg.length;
    var existingDescCount = withImg.filter(function (id) { var a = partGetAccById(curP, id); return a && a.description && a.description.trim(); }).length;
    var overwriteDescDefault = true;
    var willSkipDesc = overwriteDescDefault ? 0 : existingDescCount;
    var modal = document.createElement('div');
    modal.className = 'om-modal';
    modal.style.setProperty('z-index', '2147483647', 'important');
    modal.innerHTML = '<div class="om-modal-box" style="background:' + (state.darkMode ? '#1e1e24' : '#ececef') + ';color:' + (state.darkMode ? '#eee' : '#111') + '">' +
        '<div class="om-modal-title"><i class="fa-solid fa-wand-magic-sparkles" style="margin-right:6px;color:var(--SmartThemeQuoteColor,#7c6daf)"></i>AI 批量生成单品描述</div>' +
        '<div style="font-size:.82em;opacity:.7;margin-bottom:8px">' +
        '共选中 ' + ids.length + ' 个单品，其中 ' + withImg.length + ' 个有图片' +
        (skipCount > 0 ? '，' + skipCount + ' 个无图片将跳过' : '') +
        (existingDescCount > 0 ? '<br><span id="om-acc-batch-skip-desc">' + (overwriteDescDefault ? existingDescCount + ' 个已有描述将重新生成' : existingDescCount + ' 个已有描述将保留不改') + '</span>' : '') +
        '</div>' +
        '<div style="font-size:.78em;opacity:.5;margin-bottom:8px">共需 <span id="om-acc-batch-call-count">' + (withImg.length - willSkipDesc) + '</span> 次 API 调用</div>' +
        '<div style="border:1px solid rgba(127,127,127,.12);border-radius:8px;padding:10px;margin-bottom:8px">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer"><input type="checkbox" id="om-acc-batch-overwrite-desc" checked /> 重新生成描述（覆盖现有描述）</label>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:.82em;cursor:pointer;margin-top:8px"><input type="checkbox" id="om-acc-batch-autoname" checked /> 同时生成单品名称（覆盖现有名称）</label>' +
        '</div>' +
        '<div id="om-acc-batch-progress" style="display:none;margin:10px 0">' +
        '<div style="font-size:.82em;margin-bottom:6px" id="om-acc-batch-prog-text">准备中...</div>' +
        '<div style="height:6px;background:rgba(127,127,127,.15);border-radius:3px;overflow:hidden">' +
        '<div id="om-acc-batch-prog-bar" style="height:100%;width:0%;background:var(--SmartThemeQuoteColor,#7c6daf);border-radius:3px;transition:width .3s"></div></div></div>' +
        '<div id="om-acc-batch-result" style="display:none;margin:8px 0;font-size:.82em;max-height:120px;overflow-y:auto"></div>' +
        '<div class="om-btn-row" style="margin-top:10px" id="om-acc-batch-actions">' +
        '<button class="om-btn om-btn-safe" id="om-acc-batch-start"><i class="fa-solid fa-play"></i> 开始生成</button>' +
        '<button class="om-btn om-btn-outline" id="om-acc-batch-close">取消</button></div></div>';

    var _mp = getPopupLayer();
    modal.style.cssText = 'position:absolute !important;inset:0 !important;z-index:1 !important;background:rgba(0,0,0,.45) !important;display:flex !important;align-items:center !important;justify-content:center !important;padding:20px !important;box-sizing:border-box !important;pointer-events:auto !important;';
    _mp.appendChild(modal);

    var modalAlive = true;
    function removeModal() { if (modalAlive && modal.parentNode) { modal.parentNode.removeChild(modal); modalAlive = false; } }

    modal.addEventListener('click', function (e) { if (e.target === modal) removeModal(); });
    modal.querySelector('#om-acc-batch-close').addEventListener('click', function () { removeModal(); });

    function updateAccBatchCallCount() {
        var overwriteDescEl = modal.querySelector('#om-acc-batch-overwrite-desc');
        var overwriteDesc = !overwriteDescEl || overwriteDescEl.checked;
        var callEl = modal.querySelector('#om-acc-batch-call-count');
        if (callEl) callEl.textContent = Math.max(0, withImg.length - (overwriteDesc ? 0 : existingDescCount));
        var skipEl = modal.querySelector('#om-acc-batch-skip-desc');
        if (skipEl) skipEl.textContent = overwriteDesc ? existingDescCount + ' 个已有描述将重新生成' : existingDescCount + ' 个已有描述将保留不改';
    }
    var accOverwriteDescToggle = modal.querySelector('#om-acc-batch-overwrite-desc');
    if (accOverwriteDescToggle) accOverwriteDescToggle.addEventListener('change', updateAccBatchCallCount);
    updateAccBatchCallCount();

    modal.querySelector('#om-acc-batch-start').addEventListener('click', function () {
        modal.querySelector('#om-acc-batch-progress').style.display = 'block';
        modal.querySelector('#om-acc-batch-start').disabled = true;
        modal.querySelector('#om-acc-batch-start').textContent = '生成中...';
        var closeBtn = modal.querySelector('#om-acc-batch-close');
        closeBtn.textContent = '后台运行';
        closeBtn.onclick = function () {
            removeModal();
            toast('AI 正在生成单品描述，可继续使用酒馆，完成后会通知');
        };

        var options = {
            overwriteDescription: modal.querySelector('#om-acc-batch-overwrite-desc').checked,
            autoName: modal.querySelector('#om-acc-batch-autoname').checked
        };

        batchGenerateAccDescriptions(ids, options,
            function (done, total, msg) {
                var pct = total > 0 ? Math.round(done / total * 100) : 0;
                if (modalAlive) {
                    var bar = modal.querySelector('#om-acc-batch-prog-bar');
                    var txt = modal.querySelector('#om-acc-batch-prog-text');
                    if (bar) bar.style.width = pct + '%';
                    if (txt) txt.textContent = done + '/' + total + ' ' + msg;
                }
            },
            function (err, doneCount, errors) {
                var successCount = (doneCount || 0) - (errors ? errors.length : 0);
                var failCount = errors ? errors.length : 0;

                if (modalAlive) {
                    var bar = modal.querySelector('#om-acc-batch-prog-bar');
                    if (bar) bar.style.width = '100%';
                    var resultEl = modal.querySelector('#om-acc-batch-result');
                    resultEl.style.display = 'block';
                    if (err && !doneCount) {
                        resultEl.innerHTML = '<div style="color:#e57373"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(err) + '</div>';
                    } else {
                        var html2 = '<div style="color:#4caf50;font-weight:600">成功生成 ' + successCount + ' 条</div>';
                        if (failCount > 0) {
                            html2 += '<div style="color:#ff8c42;margin-top:4px">' + failCount + ' 个失败：</div>';
                            errors.forEach(function (e) {
                                html2 += '<div style="opacity:.6;font-size:.9em;margin-left:8px">· ' + esc(e.name) + '：' + esc(e.error) + '</div>';
                            });
                        }
                        resultEl.innerHTML = html2;
                    }
                    var actionsEl = modal.querySelector('#om-acc-batch-actions');
                    actionsEl.innerHTML = '<button class="om-btn om-btn-safe" id="om-acc-batch-done">完成</button>';
                    modal.querySelector('#om-acc-batch-done').addEventListener('click', function () {
                        removeModal();
                        if (fn.renderAccCatbar) fn.renderAccCatbar();
                        fn.renderGrid();
                    });
                } else {
                    if (failCount > 0) {
                        toast('AI 单品描述生成完成：' + successCount + ' 成功，' + failCount + ' 失败');
                    } else {
                        toast('AI 单品描述生成完成：' + successCount + ' 条描述已就绪');
                    }
                    if (fn.renderAccCatbar) fn.renderAccCatbar();
                    fn.renderGrid();
                }
            }
        );
    });
}

// ── 移动到… 面板 ─────────────────────────────────────────
// selectedIds: 要移动的 outfit id 数组
// onDone: 完成后回调
function openMoveToPanel(selectedIds, onDone) {
    var d = load();
    var sourcePartKey = currentPartKey();
    var count = selectedIds.length;
    var isCharView = d.currentView === 'char' && d.currentChar;
    var currentLabel = isCharView ? (d.currentChar === SHARED_CHAR_KEY ? SHARED_CHAR_LABEL : d.currentChar) : 'User';
    var isCopy = false;

    // ── 第一步：选类型 ──
    var html = '<div class="om-sheet-title"><i class="fa-solid fa-arrow-right-arrow-left"></i>移动 / 复制</div>';
    html += '<div class="om-hint" style="margin-bottom:10px">' + count + ' 套穿搭 · 来自：' + esc(currentLabel) + '</div>';
    html += '<div class="om-move-toggle">' +
        '<button class="om-move-toggle-btn on" data-mode="move"><i class="fa-solid fa-arrow-right-arrow-left"></i> 移动</button>' +
        '<button class="om-move-toggle-btn" data-mode="copy"><i class="fa-regular fa-copy"></i> 复制</button></div>';
    html += '<div class="om-divider" style="margin:10px 0"></div>';
    html += '<div class="om-cat-item om-move-type" data-type="user" style="cursor:pointer;padding:14px"><i class="fa-solid fa-user" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">User 衣柜</span></div>';
    html += '<div class="om-cat-item om-move-type" data-type="char" style="cursor:pointer;padding:14px"><i class="fa-solid fa-masks-theater" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">角色衣柜</span></div>';
    if (Array.isArray(d.presets) && d.presets.length > 0) {
        html += '<div class="om-divider" style="margin:10px 0"></div>';
        html += '<div class="om-cat-item om-move-type" data-type="preset" style="cursor:pointer;padding:14px"><i class="fa-solid fa-bookmark" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">复制到预设</span></div>';
    }

    var sheet1 = createSheet(html);

    sheet1.querySelectorAll('.om-move-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            isCopy = btn.dataset.mode === 'copy';
            sheet1.querySelectorAll('.om-move-toggle-btn').forEach(function (b) { b.classList.toggle('on', b === btn); });
        });
    });
    sheet1.querySelectorAll('.om-move-type').forEach(function (item) {
        item.addEventListener('click', function () {
            var type = item.dataset.type;
            closeSheet(sheet1);
            openMoveDetailSheet(selectedIds, sourcePartKey, type, isCopy, onDone);
        });
    });
}

// ── 第二步：折叠式详情选择 ──
function openMoveDetailSheet(selectedIds, sourcePartKey, type, isCopy, onDone) {
    var d = load();
    var count = selectedIds.length;
    var actionWord = isCopy ? '复制' : '移动';
    var exp = {}; // 折叠状态

    function doAction(targetType, targetChar, presetIdx, targetCat, targetSub) {
        closeSheet(sheet);
        executeMove(selectedIds, sourcePartKey, targetType, targetChar, presetIdx, targetCat, targetSub, isCopy, onDone);
    }

    function buildCatTree(cats, indent) {
        var h = '';
        h += '<div class="om-acc-leaf" data-cat="" data-sub="" style="padding-left:' + indent + 'px;opacity:.55">不设分类</div>';
        (cats || []).forEach(function (catObj) {
            var catName = typeof catObj === 'object' ? catObj.name : catObj;
            var children = typeof catObj === 'object' ? (catObj.children || []) : [];
            if (children.length > 0) {
                var isOpen = exp['cat_' + catName];
                h += '<div class="om-acc-row om-acc-cat-toggle" data-key="cat_' + esc(catName) + '" style="padding-left:' + (indent - 4) + 'px"><i class="fa-solid fa-chevron-right om-acc-arrow' + (isOpen ? ' open' : '') + '"></i><span style="font-weight:600">' + esc(catName) + '</span></div>';
                if (isOpen) {
                    h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="" style="padding-left:' + (indent + 16) + 'px">全部' + esc(catName) + '</div>';
                    children.forEach(function (sc) {
                        h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="' + esc(sc) + '" style="padding-left:' + (indent + 16) + 'px"><i class="fa-solid fa-turn-up fa-rotate-90" style="font-size:.55em;opacity:.25;margin-right:5px"></i>' + esc(sc) + '</div>';
                    });
                }
            } else {
                h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="" style="padding-left:' + indent + 'px">' + esc(catName) + '</div>';
            }
        });
        return h;
    }

    function render() {
        var dd = load();
        var h = '';
        if (type === 'user') {
            var userPart = loadPartition(currentUserPartKey());
            h += buildCatTree((userPart && userPart.categories) || [], 16);
        } else if (type === 'char') {
            // 通用衣柜
            var shPart = loadPartition('char:' + SHARED_CHAR_KEY);
            var shOpen = exp[SHARED_CHAR_KEY];
            h += '<div class="om-acc-row om-acc-char" data-cn="' + SHARED_CHAR_KEY + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (shOpen ? ' open' : '') + '"></i><i class="fa-solid fa-globe" style="opacity:.45;margin-right:5px"></i>' + SHARED_CHAR_LABEL + '</div>';
            if (shOpen) h += buildCatTree((shPart && shPart.categories) || [], 36);
            // 其他角色
            (dd.charNames || []).forEach(function (cn) {
                var cid = charIdByName(cn);
                var cd = cid ? loadPartition('char:' + cid) : getCharData(dd, cn);
                var cOpen = exp[cn];
                h += '<div class="om-acc-row om-acc-char" data-cn="' + esc(cn) + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (cOpen ? ' open' : '') + '"></i><i class="fa-solid fa-masks-theater" style="opacity:.45;margin-right:5px"></i>' + esc(cn) + '</div>';
                if (cOpen) h += buildCatTree(cd.categories, 36);
            });
        } else if (type === 'preset') {
            var meta = loadMeta();
            (meta.presets || []).forEach(function (p, pi) {
                if (!p) return;
                var pp = p.partKey ? loadPartition(p.partKey) : null;
                var pOpen = exp['p_' + pi];
                h += '<div class="om-acc-row om-acc-preset" data-pidx="' + pi + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (pOpen ? ' open' : '') + '"></i><i class="fa-solid fa-bookmark" style="opacity:.45;margin-right:5px"></i>' + esc(p.name || '预设' + (pi + 1)) + ' <span style="opacity:.4;font-size:.85em">' + (pp && pp.outfits ? pp.outfits.length : 0) + '套</span></div>';
                if (pOpen) h += buildCatTree((pp && pp.categories) || [], 36);
            });
        }
        return h;
    }

    function bindEvents() {
        var content = sheet.querySelector('.om-sheet-scroll') || sheet;
        // 角色折叠
        content.querySelectorAll('.om-acc-char').forEach(function (row) {
            row.addEventListener('click', function () { exp[row.dataset.cn] = !exp[row.dataset.cn]; refresh(); });
        });
        // 预设折叠
        content.querySelectorAll('.om-acc-preset').forEach(function (row) {
            row.addEventListener('click', function () { var k = 'p_' + row.dataset.pidx; exp[k] = !exp[k]; refresh(); });
        });
        // 分类折叠
        content.querySelectorAll('.om-acc-cat-toggle').forEach(function (row) {
            row.addEventListener('click', function () { exp[row.dataset.key] = !exp[row.dataset.key]; refresh(); });
        });
        // 叶子点击 → 执行
        content.querySelectorAll('.om-acc-leaf').forEach(function (leaf) {
            leaf.addEventListener('click', function () {
                var cat = leaf.dataset.cat || '';
                var sub = leaf.dataset.sub || '';
                if (type === 'user') {
                    doAction('user', '', -1, cat, sub);
                } else if (type === 'char') {
                    // 找到所属角色：向上找最近的展开的om-acc-char
                    var charName = '';
                    var prev = leaf.previousElementSibling;
                    while (prev) {
                        if (prev.classList.contains('om-acc-char') && exp[prev.dataset.cn]) { charName = prev.dataset.cn; break; }
                        prev = prev.previousElementSibling;
                    }
                    if (charName) doAction('char', charName, -1, cat, sub);
                } else if (type === 'preset') {
                    var pidx = -1;
                    var prev2 = leaf.previousElementSibling;
                    while (prev2) {
                        if (prev2.classList.contains('om-acc-preset') && exp['p_' + prev2.dataset.pidx]) { pidx = parseInt(prev2.dataset.pidx); break; }
                        prev2 = prev2.previousElementSibling;
                    }
                    if (pidx >= 0) doAction('preset', '', pidx, cat, sub);
                }
            });
        });
    }

    function refresh() {
        var scrollEl = sheet.querySelector('.om-sheet-scroll');
        var scrollTop = scrollEl ? scrollEl.scrollTop : 0;
        var body = sheet.querySelector('.om-acc-body');
        if (body) body.innerHTML = render();
        bindEvents();
        if (scrollEl) scrollEl.scrollTop = scrollTop;
    }

    var titleIcon = type === 'user' ? 'fa-user' : type === 'char' ? 'fa-masks-theater' : 'fa-bookmark';
    var titleText = type === 'user' ? (actionWord + '到 User 衣柜') : type === 'char' ? (actionWord + '到角色衣柜') : '复制到预设';

    var sheet = createSheet(
        '<div class="om-sheet-title"><i class="fa-solid ' + titleIcon + '"></i>' + titleText + '</div>' +
        '<div class="om-hint" style="margin-bottom:8px">' + count + ' 套穿搭</div>' +
        '<div class="om-acc-body">' + render() + '</div>'
    );
    bindEvents();
}

// ── 执行移动/复制 ──
function executeMove(selectedIds, sourcePartKey, targetType, targetChar, presetIdx, targetCat, targetSub, isCopy, onDone) {
    var count = selectedIds.length;
    var sourcePart = loadPartition(sourcePartKey);
    ensurePartArrays(sourcePart);
    var targetInfo = getOutfitMoveTarget(targetType, targetChar, presetIdx);
    if (!targetInfo.partKey) { toast('目标衣柜不存在', true); return; }
    var samePartition = sourcePartKey === targetInfo.partKey;

    // 收集要操作的 outfit 对象
    var sourceOutfits = [];
    selectedIds.forEach(function (id) {
        var o = partGetById(sourcePart, id);
        if (o) sourceOutfits.push(o);
    });

    if (sourceOutfits.length === 0) { toast('未找到穿搭', true); return; }

    if (samePartition && !isCopy) {
        // ── 同视角改分类 ──
        sourceOutfits.forEach(function (o) {
            o.category = targetCat;
            o.subCategory = targetSub || '';
        });
        savePartition(sourcePartKey, sourcePart);
        syncActivePartitions(sourcePartKey, sourcePart.activeIds || []);
        var catLabel = targetCat ? (targetSub ? '「' + targetCat + ' > ' + targetSub + '」' : '「' + targetCat + '」') : '无分类';
        toast('✅ 已将 ' + count + ' 套更改为' + catLabel);
    } else if (targetType === 'preset') {
        // ── 复制到预设（预设始终是复制）──
        var presetPart = loadPartition(targetInfo.partKey);
        ensurePartArrays(presetPart);
        sourceOutfits.forEach(function (o) {
            var copy = JSON.parse(JSON.stringify(o));
            copy.id = genId();
            copy.category = targetCat;
            copy.subCategory = targetSub || '';
            if (!samePartition) clearOutfitKits(copy);
            presetPart.outfits.push(copy);
        });
        savePartition(targetInfo.partKey, presetPart);
        toast('✅ 已复制 ' + count + ' 套到预设「' + targetInfo.label + '」');
    } else if (isCopy) {
        // ── 复制到目标 ──
        var targetPart2 = loadPartition(targetInfo.partKey);
        ensurePartArrays(targetPart2);
        sourceOutfits.forEach(function (o) {
            var copy = JSON.parse(JSON.stringify(o));
            copy.id = genId();
            copy.category = targetCat;
            copy.subCategory = targetSub || '';
            if (!samePartition) clearOutfitKits(copy);
            targetPart2.outfits.push(copy);
        });
        savePartition(targetInfo.partKey, targetPart2);
        toast('✅ 已复制 ' + count + ' 套到「' + targetInfo.label + '」');
    } else {
        // ── 跨视角移动（User↔Char / Char↔Char）──
        var targetPart = loadPartition(targetInfo.partKey);
        ensurePartArrays(targetPart);
        var existingIds = {};
        targetPart.outfits.forEach(function (o) { if (o && o.id) existingIds[o.id] = true; });

        sourceOutfits.forEach(function (o) {
            var moved = JSON.parse(JSON.stringify(o));
            while (existingIds[moved.id]) moved.id = genId();
            existingIds[moved.id] = true;
            moved.category = targetCat;
            moved.subCategory = targetSub || '';
            clearOutfitKits(moved);
            targetPart.outfits.push(moved);
        });

        sourcePart.outfits = (sourcePart.outfits || []).filter(function (o) { return selectedIds.indexOf(o.id) === -1; });
        sourcePart.activeIds = (sourcePart.activeIds || []).filter(function (id) { return selectedIds.indexOf(id) === -1; });
        savePartition(targetInfo.partKey, targetPart);
        savePartition(sourcePartKey, sourcePart);
        syncActivePartitions(sourcePartKey, sourcePart.activeIds || []);
        toast('✅ 已移动 ' + count + ' 套到「' + targetInfo.label + '」');
    }

    if (onDone) onDone();
}

// ── 单品移动 / 复制 ──────────────────────────────────────
function openAccMoveToPanel(accIds, onDone) {
    accIds = (accIds || []).slice();
    if (accIds.length === 0) { toast('请先选择单品', true); return; }
    var sourcePartKey = currentPartKey();
    var sourcePart = loadPartition(sourcePartKey);
    var sourceAccs = accIds.map(function (id) { return partGetAccById(sourcePart, id); }).filter(function (a) { return !!a; });
    if (sourceAccs.length === 0) { toast('未找到单品', true); return; }

    var d = load();
    var isCopy = false;
    var isCharView = d.currentView === 'char' && d.currentChar;
    var currentLabel = isCharView ? (d.currentChar === SHARED_CHAR_KEY ? SHARED_CHAR_LABEL : d.currentChar) : 'User';

    var html = '<div class="om-sheet-title"><i class="fa-solid fa-arrow-right-arrow-left"></i>移动 / 复制</div>';
    html += '<div class="om-hint" style="margin-bottom:10px">' + sourceAccs.length + ' 件单品 · 来自：' + esc(currentLabel) + '</div>';
    html += '<div class="om-move-toggle">' +
        '<button class="om-move-toggle-btn on" data-mode="move"><i class="fa-solid fa-arrow-right-arrow-left"></i> 移动</button>' +
        '<button class="om-move-toggle-btn" data-mode="copy"><i class="fa-regular fa-copy"></i> 复制</button></div>';
    html += '<div class="om-divider" style="margin:10px 0"></div>';
    html += '<div class="om-cat-item om-acc-move-type" data-type="user" style="cursor:pointer;padding:14px"><i class="fa-solid fa-user" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">User 衣柜</span></div>';
    html += '<div class="om-cat-item om-acc-move-type" data-type="char" style="cursor:pointer;padding:14px"><i class="fa-solid fa-masks-theater" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">角色衣柜</span></div>';
    if (Array.isArray(d.presets) && d.presets.length > 0) {
        html += '<div class="om-divider" style="margin:10px 0"></div>';
        html += '<div class="om-cat-item om-acc-move-type" data-type="preset" style="cursor:pointer;padding:14px"><i class="fa-solid fa-bookmark" style="opacity:.45;width:22px;text-align:center;margin-right:8px"></i><span class="om-cat-name" style="font-weight:600;font-size:1em">复制到预设</span></div>';
    }

    var sheet = createSheet(html);
    sheet.querySelectorAll('.om-move-toggle-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            isCopy = btn.dataset.mode === 'copy';
            sheet.querySelectorAll('.om-move-toggle-btn').forEach(function (b) { b.classList.toggle('on', b === btn); });
        });
    });
    sheet.querySelectorAll('.om-acc-move-type').forEach(function (row) {
        row.addEventListener('click', function () {
            closeSheet(sheet);
            openAccMoveDetailSheet(sourceAccs, sourcePartKey, row.dataset.type, isCopy, onDone);
        });
    });
}

function openAccMoveDetailSheet(sourceAccs, sourcePartKey, type, isCopy, onDone) {
    var d = load();
    var count = sourceAccs.length;
    var exp = {};
    var actionWord = isCopy ? '复制' : '移动';

    function doAction(targetType, targetChar, presetIdx, targetCat, targetSub) {
        closeSheet(sheet);
        executeAccMove(sourceAccs, sourcePartKey, targetType, targetChar, presetIdx, targetCat, targetSub, isCopy, onDone);
    }

    function buildCatTree(cats, indent) {
        var h = '';
        h += '<div class="om-acc-leaf" data-cat="" data-sub="" style="padding-left:' + indent + 'px;opacity:.55">不设分类</div>';
        (cats || []).forEach(function (catObj) {
            var catName = typeof catObj === 'object' ? catObj.name : catObj;
            var children = typeof catObj === 'object' ? (catObj.children || []) : [];
            if (children.length > 0) {
                var isOpen = exp['cat_' + catName];
                h += '<div class="om-acc-row om-acc-cat-toggle" data-key="cat_' + esc(catName) + '" style="padding-left:' + (indent - 4) + 'px"><i class="fa-solid fa-chevron-right om-acc-arrow' + (isOpen ? ' open' : '') + '"></i><span style="font-weight:600">' + esc(catName) + '</span></div>';
                if (isOpen) {
                    h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="" style="padding-left:' + (indent + 16) + 'px">全部' + esc(catName) + '</div>';
                    children.forEach(function (sc) {
                        h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="' + esc(sc) + '" style="padding-left:' + (indent + 16) + 'px"><i class="fa-solid fa-turn-up fa-rotate-90" style="font-size:.55em;opacity:.25;margin-right:5px"></i>' + esc(sc) + '</div>';
                    });
                }
            } else {
                h += '<div class="om-acc-leaf" data-cat="' + esc(catName) + '" data-sub="" style="padding-left:' + indent + 'px">' + esc(catName) + '</div>';
            }
        });
        return h;
    }

    function render() {
        var dd = load();
        var h = '';
        if (type === 'user') {
            var up = loadPartition(currentUserPartKey());
            h += buildCatTree(up.accCategories || [], 16);
        } else if (type === 'char') {
            var shCd = getCharData(dd, SHARED_CHAR_KEY);
            var shOpen = exp[SHARED_CHAR_KEY];
            h += '<div class="om-acc-row om-acc-char" data-cn="' + SHARED_CHAR_KEY + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (shOpen ? ' open' : '') + '"></i><i class="fa-solid fa-globe" style="opacity:.45;margin-right:5px"></i>' + SHARED_CHAR_LABEL + '</div>';
            if (shOpen) h += buildCatTree(shCd.accCategories || [], 36);
            (dd.charNames || []).forEach(function (cn) {
                var cd = getCharData(dd, cn);
                var cOpen = exp[cn];
                h += '<div class="om-acc-row om-acc-char" data-cn="' + esc(cn) + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (cOpen ? ' open' : '') + '"></i><i class="fa-solid fa-masks-theater" style="opacity:.45;margin-right:5px"></i>' + esc(cn) + '</div>';
                if (cOpen) h += buildCatTree(cd.accCategories || [], 36);
            });
        } else if (type === 'preset') {
            (dd.presets || []).forEach(function (p, pi) {
                if (!p) return;
                var pOpen = exp['p_' + pi];
                h += '<div class="om-acc-row om-acc-preset" data-pidx="' + pi + '"><i class="fa-solid fa-chevron-right om-acc-arrow' + (pOpen ? ' open' : '') + '"></i><i class="fa-solid fa-bookmark" style="opacity:.45;margin-right:5px"></i>' + esc(p.name || '预设' + (pi + 1)) + ' <span style="opacity:.4;font-size:.85em">' + (p.accessories ? p.accessories.length : 0) + '件</span></div>';
                if (pOpen) h += buildCatTree((p && p.accCategories) || [], 36);
            });
        }
        return h;
    }

    function refresh() {
        var scrollEl = sheet.querySelector('.om-sheet-scroll');
        var scrollTop = scrollEl ? scrollEl.scrollTop : 0;
        var body = sheet.querySelector('.om-acc-body');
        if (body) body.innerHTML = render();
        bindEvents();
        if (scrollEl) scrollEl.scrollTop = scrollTop;
    }

    function bindEvents() {
        var content = sheet.querySelector('.om-sheet-scroll') || sheet;
        content.querySelectorAll('.om-acc-char').forEach(function (row) {
            row.addEventListener('click', function () { exp[row.dataset.cn] = !exp[row.dataset.cn]; refresh(); });
        });
        content.querySelectorAll('.om-acc-preset').forEach(function (row) {
            row.addEventListener('click', function () { var k = 'p_' + row.dataset.pidx; exp[k] = !exp[k]; refresh(); });
        });
        content.querySelectorAll('.om-acc-cat-toggle').forEach(function (row) {
            row.addEventListener('click', function () { exp[row.dataset.key] = !exp[row.dataset.key]; refresh(); });
        });
        content.querySelectorAll('.om-acc-leaf').forEach(function (leaf) {
            leaf.addEventListener('click', function () {
                var cat = leaf.dataset.cat || '';
                var sub = leaf.dataset.sub || '';
                if (type === 'user') {
                    doAction('user', '', -1, cat, sub);
                } else if (type === 'char') {
                    var charName = '';
                    var prev = leaf.previousElementSibling;
                    while (prev) {
                        if (prev.classList.contains('om-acc-char') && exp[prev.dataset.cn]) { charName = prev.dataset.cn; break; }
                        prev = prev.previousElementSibling;
                    }
                    if (charName) doAction('char', charName, -1, cat, sub);
                } else if (type === 'preset') {
                    var pidx = -1;
                    var prev2 = leaf.previousElementSibling;
                    while (prev2) {
                        if (prev2.classList.contains('om-acc-preset') && exp['p_' + prev2.dataset.pidx]) { pidx = parseInt(prev2.dataset.pidx); break; }
                        prev2 = prev2.previousElementSibling;
                    }
                    if (pidx >= 0) doAction('preset', '', pidx, cat, sub);
                }
            });
        });
    }

    var titleIcon = type === 'user' ? 'fa-user' : type === 'char' ? 'fa-masks-theater' : 'fa-bookmark';
    var titleText = type === 'user' ? (actionWord + '到 User 衣柜') : type === 'char' ? (actionWord + '到角色衣柜') : '复制到预设';

    var sheet = createSheet(
        '<div class="om-sheet-title"><i class="fa-solid ' + titleIcon + '"></i>' + titleText + '</div>' +
        '<div class="om-hint" style="margin-bottom:8px">' + count + ' 件单品</div>' +
        '<div class="om-acc-body">' + render() + '</div>'
    );
    bindEvents();
}

function executeAccMove(sourceAccs, sourcePartKey, targetType, targetChar, presetIdx, targetCat, targetSub, isCopy, onDone) {
    var count = sourceAccs.length;
    var meta = loadMeta();
    var targetPartKey = '';
    var targetLabel = '目标衣柜';
    var effectiveCopy = isCopy || targetType === 'preset';

    if (targetType === 'user') {
        targetPartKey = currentUserPartKey();
        targetLabel = 'User';
    } else if (targetType === 'char' && targetChar) {
        if (targetChar === SHARED_CHAR_KEY) {
            targetPartKey = 'char:' + SHARED_CHAR_KEY;
            targetLabel = SHARED_CHAR_LABEL;
        } else {
            var cid = charIdByName(targetChar);
            if (cid) targetPartKey = 'char:' + cid;
            targetLabel = targetChar;
        }
    } else if (targetType === 'preset') {
        var p = (meta.presets || [])[presetIdx];
        if (p) {
            targetPartKey = p.partKey;
            targetLabel = p.name || '预设';
        }
    }

    if (!targetPartKey) { toast('目标衣柜不存在', true); return; }
    var samePartition = sourcePartKey === targetPartKey;

    if (samePartition && !effectiveCopy) {
        var samePart = loadPartition(sourcePartKey);
        sourceAccs.forEach(function (src) {
            var acc = partGetAccById(samePart, src.id);
            if (acc) {
                acc.category = targetCat;
                acc.subCategory = targetSub || '';
            }
        });
        savePartition(sourcePartKey, samePart);
        toast('已更新 ' + count + ' 件单品分类');
        if (onDone) onDone();
        return;
    }

    var targetPart = loadPartition(targetPartKey);
    if (!Array.isArray(targetPart.accessories)) targetPart.accessories = [];
    var usedIds = {};
    targetPart.accessories.forEach(function (acc) { if (acc && acc.id) usedIds[acc.id] = true; });
    sourceAccs.forEach(function (src) {
        var copy = JSON.parse(JSON.stringify(src));
        do { copy.id = 'a_' + genId().substring(0, 8); } while (usedIds[copy.id]);
        usedIds[copy.id] = true;
        copy.category = targetCat;
        copy.subCategory = targetSub || '';
        targetPart.accessories.push(copy);
    });
    savePartition(targetPartKey, targetPart);

    if (!effectiveCopy) {
        var sourcePart = loadPartition(sourcePartKey);
        var sourceIds = sourceAccs.map(function (a) { return a.id; });
        sourcePart.accessories = (sourcePart.accessories || []).filter(function (a) { return sourceIds.indexOf(a.id) === -1; });
        sourceIds.forEach(function (id) { cleanAccIdFromKits(sourcePart, id); });
        if (state.kitFocusPartKey === sourcePartKey) {
            state.kitDraftAccIds = (state.kitDraftAccIds || []).filter(function (id) { return sourceIds.indexOf(id) === -1; });
        }
        savePartition(sourcePartKey, sourcePart);
    }

    toast((effectiveCopy ? '已复制 ' : '已移动 ') + count + ' 件单品到「' + targetLabel + '」');
    if (onDone) onDone();
}

// ── 导出 ──────────────────────────────────────────────────
export { openBatchDescModal, openAccBatchDescModal, openBatchTagPanel, openBatchImportModal, openMoveToPanel, openAccMoveToPanel };
export { exportData, importData, processImport };

export function registerBatchFn() {
    fn.openBatchDescModal = openBatchDescModal;
    fn.openAccBatchDescModal = openAccBatchDescModal;
    fn.openBatchTagPanel = openBatchTagPanel;
    fn.openBatchImportModal = openBatchImportModal;
    fn.openMoveToPanel = openMoveToPanel;
    fn.openAccMoveToPanel = openAccMoveToPanel;
    fn.exportData = exportData;
    fn.importData = importData;
}
