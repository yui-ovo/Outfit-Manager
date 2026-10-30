// ── 穿搭管理器 · 数据模型 v2 ──────────────────────────────
// meta 默认值 + partition 默认值 + 分类辅助 + partition 访问辅助

// ── 通用衣柜保留键 ─────────────────────────────────────────
export var SHARED_CHAR_KEY = '__shared__';
export var SHARED_CHAR_LABEL = '通用衣柜';

// ══════════════════════════════════════════════════════════
//  默认数据结构
// ══════════════════════════════════════════════════════════

// ── meta 默认值（全局设置 + 索引 + 激活追踪）──
export function defMeta() {
    return {
        _version: 2,

        // 预设索引（目录，不含 outfits）
        presets: [],
        activePresetId: null,       // null = user:__default__

        // 角色索引
        charIndex: [],              // [{ id, name, partKey }]
        charFavorites: [],          // charId 数组
        charGroups: {},             // { '组名': [charId, ...] }

        // 激活追踪（inject 预加载用）
        activePartitions: {},       // { partKey: [activeId, ...] }

        // UI 状态
        currentView: 'user',
        currentChar: '',            // 存 charId
        darkMode: false,            // 插件主题，刷新后恢复
        showBall: true,
        fabImage: '',
        fabSize: 38,
        fabPos: null,
        tagOrder: [],

        // 注入配置
        mode: 'text',
        injectPosition: 'user',
        singleTemplate: '[User当前穿着]\n{{description}}\n（禁止编造其他服装。严禁集中罗列服装信息，服装细节必须分散融入不同的动作、触感、环境互动中，每次只带出一两个细节。）',
        multiTemplate: '[User的可选穿搭]\n{{wardrobe}}\n（禁止编造以上之外的服装。根据场景标签匹配穿搭，若回复中出现场景转换则对应切换穿搭。严禁集中罗列服装信息，服装细节必须分散融入动作、触感、环境互动中，每次只带出一两个细节。）',
        charSingleTemplate: '[{{charName}}当前穿着]\n{{description}}\n（禁止编造其他服装。严禁集中罗列服装信息，服装细节必须分散融入不同的动作、触感、环境互动中，每次只带出一两个细节。）',
        charMultiTemplate: '[{{charName}}的可选穿搭]\n{{wardrobe}}\n（禁止编造以上之外的服装。根据场景标签匹配穿搭，若回复中出现场景转换则对应切换穿搭。严禁集中罗列服装信息，服装细节必须分散融入动作、触感、环境互动中，每次只带出一两个细节。）',
        imagePrompt: '图中为角色当前穿着，禁止编造其他服装。严禁集中罗列，服装细节必须分散融入动作、触感、环境互动中，每次只带出一两个细节。',
        multiImagePrompt: '以上图片为可选穿搭，根据场景标签匹配，场景转换则切换穿搭，禁止编造其他服装。严禁集中罗列，细节分散融入动作和互动中。',
        debug: false,

        // API
        apiVision: {
            endpoint: '', key: '', model: '',
            prompt: '用JSON回复（不要代码块）：{"name":"穿搭名称6字以内","description":"描述服装类型颜色材质款式搭配，只写服装不写人，100-200字"}',
            accPrompt: '用JSON回复（不要代码块）：{"name":"单品名称6字以内","description":"只描述图中的【{{accCategory}}】这一件单品，详细描述它的材质、颜色、款式、细节特征，不要描述其他服饰或整体穿搭，80-150字"}',
            promptTemplates: [],
            activePromptTemplateId: null,
            overwrite: false
        }
    };
}

// ── partition 默认值（outfits + 分类 + 激活选择 + 单品）──
export function defPartition() {
    return {
        outfits: [],
        categories: [],
        activeIds: [],
        accessories: [],       // 单品列表
        accCategories: []      // 单品分类（结构同 categories）
    };
}

// ══════════════════════════════════════════════════════════
//  数据规范化
// ══════════════════════════════════════════════════════════

export function ensureMetaDefaults(m) {
    var dm = defMeta();
    if (!m) return dm;
    for (var k in dm) { if (m[k] === undefined) m[k] = dm[k]; }
    if (!Array.isArray(m.presets)) m.presets = [];
    if (!Array.isArray(m.charIndex)) m.charIndex = [];
    if (!Array.isArray(m.charFavorites)) m.charFavorites = [];
    if (!m.charGroups || typeof m.charGroups !== 'object') m.charGroups = {};
    if (!m.activePartitions || typeof m.activePartitions !== 'object') m.activePartitions = {};
    if (!Array.isArray(m.tagOrder)) m.tagOrder = [];
    if (typeof m.darkMode !== 'boolean') m.darkMode = false;
    if (!m.apiVision) m.apiVision = defMeta().apiVision;
    else {
        var dv = defMeta().apiVision;
        for (var vk in dv) { if (m.apiVision[vk] === undefined) m.apiVision[vk] = dv[vk]; }
    }
    if (!Array.isArray(m.apiVision.promptTemplates)) m.apiVision.promptTemplates = [];
    if (m.apiVision.activePromptTemplateId === undefined) m.apiVision.activePromptTemplateId = null;
    m._version = 2;
    return m;
}

export function ensurePartDefaults(p) {
    if (!p) return defPartition();
    if (!Array.isArray(p.outfits)) p.outfits = [];
    if (!Array.isArray(p.categories)) p.categories = [];
    if (!Array.isArray(p.activeIds)) p.activeIds = [];
    if (!Array.isArray(p.accessories)) p.accessories = [];
    if (!Array.isArray(p.accCategories)) p.accCategories = [];
    // 分类树形迁移
    p.categories = migrateCategories(p.categories);
    p.accCategories = migrateCategories(p.accCategories);
    // outfit kit / favorite 规范化
    p.outfits.forEach(function (o) {
        ensureOutfitKits(o);
        if (o.favorite === undefined) o.favorite = false;
    });
    return p;
}

// ══════════════════════════════════════════════════════════
//  分类迁移 + 辅助函数
// ══════════════════════════════════════════════════════════

// 扁平字符串数组 → 树形 [{name, children:[]}]
export function migrateCategories(cats) {
    if (!Array.isArray(cats) || cats.length === 0) return cats;
    if (cats[0] && typeof cats[0] === 'object' && cats[0].name !== undefined) return cats;
    return cats.map(function (c) { return { name: c, children: [] }; });
}

export function getCatNames(cats) {
    if (!Array.isArray(cats)) return [];
    return cats.map(function (c) { return typeof c === 'object' ? c.name : c; });
}

export function getSubCats(cats, parentName) {
    if (!Array.isArray(cats)) return [];
    for (var i = 0; i < cats.length; i++) {
        var c = cats[i];
        if (typeof c === 'object' && c.name === parentName) return c.children || [];
    }
    return [];
}

export function findCatObj(cats, name) {
    if (!Array.isArray(cats)) return null;
    for (var i = 0; i < cats.length; i++) {
        if (typeof cats[i] === 'object' && cats[i].name === name) return cats[i];
    }
    return null;
}

export function hasSubCats(cats, parentName) {
    return getSubCats(cats, parentName).length > 0;
}

export function outfitInCategory(o, catName) {
    return o.category === catName;
}

export function outfitInSubCategory(o, catName, subCatName) {
    return o.category === catName && o.subCategory === subCatName;
}

// ══════════════════════════════════════════════════════════
//  Partition 数据访问辅助
// ══════════════════════════════════════════════════════════

// 在 partition 内查找 outfit by id
export function partGetById(part, id) {
    if (!part || !part.outfits) return null;
    for (var i = 0; i < part.outfits.length; i++) {
        if (part.outfits[i].id === id) return part.outfits[i];
    }
    return null;
}

// 编号取完整衣柜的存储顺序；不受勾选、收藏排序、筛选或图片缺失影响。
export function partOutfitNumbers(part) {
    var numbers = Object.create(null);
    ((part && part.outfits) || []).forEach(function (outfit, index) {
        numbers[outfit.id] = index + 1;
    });
    return numbers;
}

// 判断某 id 是否在 partition 的激活列表中
export function partIsActive(part, id) {
    if (!part || !part.activeIds) return false;
    return part.activeIds.indexOf(id) !== -1;
}

// ══════════════════════════════════════════════════════════
//  单品 (Accessory) 辅助函数
// ══════════════════════════════════════════════════════════

// 在 partition 内查找单品 by id
export function partGetAccById(part, id) {
    if (!part || !part.accessories) return null;
    for (var i = 0; i < part.accessories.length; i++) {
        if (part.accessories[i].id === id) return part.accessories[i];
    }
    return null;
}

// 确保 outfit 有合法的 kits 字段（懒补默认值）
export function ensureOutfitKits(o) {
    if (!o) return;
    if (!Array.isArray(o.kits)) o.kits = [];
    for (var i = 0; i < o.kits.length; i++) {
        var kit = o.kits[i];
        if (!kit || typeof kit !== 'object') {
            kit = {};
            o.kits[i] = kit;
        }
        if (!kit.id) kit.id = 'k_' + Date.now().toString(36) + '_' + i;
        if (!kit.name) kit.name = '套装' + (i + 1);
        if (!Array.isArray(kit.accIds)) kit.accIds = [];
        if (!Array.isArray(kit.disabledAccIds)) kit.disabledAccIds = [];
        var seen = {};
        kit.accIds = kit.accIds.filter(function (id) {
            if (!id || seen[id]) return false;
            seen[id] = true;
            return true;
        });
        var inKit = {};
        kit.accIds.forEach(function (id) { inKit[id] = true; });
        var seenDisabled = {};
        kit.disabledAccIds = kit.disabledAccIds.filter(function (id) {
            if (!id || !inKit[id] || seenDisabled[id]) return false;
            seenDisabled[id] = true;
            return true;
        });
    }
    // activeKitId 指向不存在的 kit 时置空
    if (o.activeKitId) {
        var found = false;
        for (var j = 0; j < o.kits.length; j++) {
            if (o.kits[j].id === o.activeKitId) { found = true; break; }
        }
        if (!found) o.activeKitId = null;
    }
}

// 获取 outfit 当前激活的 kit，无则返回 null
export function getActiveKit(outfit) {
    if (!outfit || !outfit.activeKitId || !Array.isArray(outfit.kits)) return null;
    for (var i = 0; i < outfit.kits.length; i++) {
        if (outfit.kits[i].id === outfit.activeKitId) return outfit.kits[i];
    }
    return null;
}

// 获取 kit 关联的单品对象列表（跳过悬空引用 + 去重）
export function getKitAccessories(part, kit) {
    if (!part || !kit || !Array.isArray(kit.accIds)) return [];
    var result = [];
    var seen = {};
    for (var i = 0; i < kit.accIds.length; i++) {
        var aid = kit.accIds[i];
        if (seen[aid]) continue;  // 去重
        seen[aid] = true;
        var acc = partGetAccById(part, aid);
        if (acc) result.push(acc);  // 跳过悬空引用
    }
    return result;
}

// 删除单品时，清理所有 outfit.kits 里的引用
export function cleanAccIdFromKits(part, accId) {
    if (!part || !part.outfits) return;
    part.outfits.forEach(function (o) {
        if (!Array.isArray(o.kits)) return;
        o.kits.forEach(function (kit) {
            if (Array.isArray(kit.accIds)) {
                var idx = kit.accIds.indexOf(accId);
                while (idx !== -1) {
                    kit.accIds.splice(idx, 1);
                    idx = kit.accIds.indexOf(accId);
                }
            }
            if (!Array.isArray(kit.disabledAccIds)) return;
            var didx = kit.disabledAccIds.indexOf(accId);
            while (didx !== -1) {
                kit.disabledAccIds.splice(didx, 1);
                didx = kit.disabledAccIds.indexOf(accId);
            }
        });
    });
}

// ══════════════════════════════════════════════════════════
//  charIndex 辅助（纯数据操作，不依赖 db.js）
// ══════════════════════════════════════════════════════════

export function findCharById(charIndex, id) {
    if (!Array.isArray(charIndex)) return null;
    for (var i = 0; i < charIndex.length; i++) {
        if (charIndex[i].id === id) return charIndex[i];
    }
    return null;
}

export function findCharByName(charIndex, name) {
    if (!Array.isArray(charIndex)) return null;
    for (var i = 0; i < charIndex.length; i++) {
        if (charIndex[i].name === name) return charIndex[i];
    }
    return null;
}

// ══════════════════════════════════════════════════════════
//  角色分组辅助（兼容层使用角色名）
// ══════════════════════════════════════════════════════════

function owns(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function validCharGroupName(name) {
    return !!name && name !== '__proto__' && name !== 'prototype' && name !== 'constructor';
}

export function renameCharGroup(d, oldName, newName) {
    var groups = d && d.charGroups;
    var target = typeof newName === 'string' ? newName.trim() : '';
    if (!groups || !owns(groups, oldName)) return { ok: false, code: 'GROUP_NOT_FOUND' };
    if (!validCharGroupName(target)) return { ok: false, code: 'GROUP_NAME_INVALID' };
    if (target === oldName) return { ok: false, code: 'GROUP_NAME_UNCHANGED' };
    if (owns(groups, target)) return { ok: false, code: 'GROUP_NAME_EXISTS' };

    // 重建对象以保留原有分组显示顺序。
    var renamed = {};
    Object.keys(groups).forEach(function (name) {
        renamed[name === oldName ? target : name] = groups[name];
    });
    d.charGroups = renamed;
    return { ok: true, oldName: oldName, newName: target };
}

export function deleteCharGroup(d, groupName, deleteMembers) {
    var groups = d && d.charGroups;
    if (!groups || !owns(groups, groupName)) return { ok: false, code: 'GROUP_NOT_FOUND', deletedNames: [] };

    var seen = Object.create(null);
    var members = [];
    (groups[groupName] || []).forEach(function (name) {
        if (typeof name !== 'string' || !name || seen[name]) return;
        seen[name] = true;
        members.push(name);
    });
    delete groups[groupName];

    if (!deleteMembers) return { ok: true, deletedNames: [], releasedNames: members };

    var existing = Object.create(null);
    (d.charNames || []).forEach(function (name) { existing[name] = true; });
    var deletedNames = members.filter(function (name) { return existing[name]; });
    var deleting = Object.create(null);
    deletedNames.forEach(function (name) {
        deleting[name] = true;
        if (d.chars) delete d.chars[name];
    });
    d.charNames = (d.charNames || []).filter(function (name) { return !deleting[name]; });
    d.charFavorites = (d.charFavorites || []).filter(function (name) { return !deleting[name]; });
    Object.keys(groups).forEach(function (name) {
        groups[name] = (groups[name] || []).filter(function (charName) { return !deleting[charName]; });
    });
    if (deleting[d.currentChar]) d.currentChar = SHARED_CHAR_KEY;

    return { ok: true, deletedNames: deletedNames, releasedNames: [] };
}

// ══════════════════════════════════════════════════════════
//  兼容旧接口（过渡期，供还没改完的模块使用）
// ══════════════════════════════════════════════════════════

// 旧版 def() — 返回完整扁平默认值
// deprecated: 仅供 load()/save() 兼容层使用
export function def() {
    var m = defMeta();
    var p = defPartition();
    var d = {};
    for (var k in m) d[k] = m[k];
    d.outfits = p.outfits;
    d.categories = p.categories;
    d.activeIds = p.activeIds;
    d.accessories = p.accessories;
    d.accCategories = p.accCategories;
    d.chars = {};
    d.charNames = [];
    return d;
}

// 旧版 ensureDefaults() — deprecated
export function ensureDefaults(d) {
    if (!d) return def();
    var dd = def();
    for (var k in dd) { if (d[k] === undefined) d[k] = dd[k]; }
    if (d.activeId && !d.activeIds) d.activeIds = [d.activeId];
    if (!Array.isArray(d.activeIds)) d.activeIds = [];
    if (!Array.isArray(d.presets)) d.presets = [];
    if (!d.chars) d.chars = {};
    if (!d.charNames) d.charNames = [];
    if (!Array.isArray(d.tagOrder)) d.tagOrder = [];
    return d;
}

// ── 旧版视角访问函数（deprecated）──
// 这些函数接收 load() 返回的伪完整对象
// 全部标记废弃，适配完成后删除

export function getCharData(d, charName) {
    if (!d.chars) d.chars = {};
    if (!d.chars[charName]) d.chars[charName] = { outfits: [], categories: [], activeIds: [] };
    return d.chars[charName];
}

export function currentOwner(d) {
    if (d.currentView === 'char' && d.currentChar) return d.currentChar;
    return 'user';
}

export function getViewOutfits(d) {
    if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).outfits;
    return d.outfits;
}

export function getViewCategories(d) {
    if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).categories;
    return d.categories;
}

export function getViewActiveIds(d) {
    if (d.currentView === 'char' && d.currentChar) return getCharData(d, d.currentChar).activeIds;
    return d.activeIds;
}

export function setViewActiveIds(d, ids) {
    if (d.currentView === 'char' && d.currentChar) { getCharData(d, d.currentChar).activeIds = ids; }
    else { d.activeIds = ids; }
}

export function getById(d, id) {
    for (var i = 0; i < d.outfits.length; i++) { if (d.outfits[i].id === id) return d.outfits[i]; }
    if (d.chars) { for (var cn in d.chars) { var co = d.chars[cn].outfits || []; for (var j = 0; j < co.length; j++) { if (co[j].id === id) return co[j]; } } }
    return null;
}

export function getViewById(d, id) {
    var list = getViewOutfits(d);
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    return null;
}

export function isActive(d, id) {
    return getViewActiveIds(d).indexOf(id) !== -1;
}
