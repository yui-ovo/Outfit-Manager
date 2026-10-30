// ══════════════════════════════════════════════════════════
// 穿搭管理器 Outfit Manager v2.1.5
// by 温水 & 克洛宜
// 存储分包架构 · meta + partition
// ══════════════════════════════════════════════════════════

import { injectStyles } from './src/styles.js';
import { initStorage, getStorageHealth } from './src/db.js';
import { toast } from './src/utils.js';
import { setupInjection } from './src/inject.js';
import { state, fn } from './src/bridge.js';
import { registerMainFn, preResolveActiveImages } from './src/ui-main.js';
import { registerSheetsFn, createSheet, closeSheet, getAllTagSuggestions } from './src/ui-sheets.js';
import { registerBatchFn, initBatchDeps } from './src/ui-batch.js';
import { injectFab, updateBtn, injectBtn, registerFabFn } from './src/ui-fab.js';
import { activateRecovery, deactivateRecovery, injectRecoveryBtn } from './src/ui-recovery.js';

// ── 注册跨模块函数 ─────────────────────────────────────
registerMainFn();
registerSheetsFn();
initBatchDeps(createSheet, closeSheet, getAllTagSuggestions);
registerBatchFn();
registerFabFn();

// ── 启动 ──────────────────────────────────────────────────
// 样式可以先注入（不依赖数据）
injectStyles();

// 初始化存储：探测后端 → 加载 meta → 迁移 → 预加载 partitions
// 所有依赖数据的操作（注入拦截、悬浮球、按钮）放在回调里
var normalUiStarted = false;
var recoveryBtnTimer = null;
var recoveryToastShown = false;
var backendUpdateToastShown = false;

function startNormalUi() {
    if (normalUiStarted) return;
    normalUiStarted = true;
    if (recoveryBtnTimer) {
        clearInterval(recoveryBtnTimer);
        recoveryBtnTimer = null;
    }
    deactivateRecovery();

    // 安装 fetch/XHR 拦截
    setupInjection();

    // 按钮和悬浮球
    setTimeout(injectBtn, 300);
    setInterval(injectBtn, 2000);
    setTimeout(injectFab, 500);
    setInterval(injectFab, 3000);

    updateBtn();
    preResolveActiveImages();
}

function handleStorageInitialization(err) {
    if (!err) {
        var health = getStorageHealth();
        if (!recoveryToastShown && health.serverRecoveryResult && health.serverRecoveryResult.recovered === true) {
            recoveryToastShown = true;
            toast('检测到衣柜索引异常，已根据可信的后端数据安全恢复。');
        }
        if (!backendUpdateToastShown && health.serverMode && health.serverPluginUpdateRecommended) {
            backendUpdateToastShown = true;
            var currentVersion = health.serverPluginVersion || '旧版（未报告版本）';
            toast('穿搭管理器后端需要更新：当前 ' + currentVersion + '，最低 ' + health.minimumServerPluginVersion + '。请重启 SillyTavern；若仍提示，请检查后端自动更新设置。', true);
        }
        startNormalUi();
        return;
    }
    console.error('[outfit-manager] 初始化失败，已进入安全恢复模式：', err);
    activateRecovery(err, startNormalUi);
    setTimeout(injectRecoveryBtn, 300);
    if (!recoveryBtnTimer) recoveryBtnTimer = setInterval(injectRecoveryBtn, 2000);
}

initStorage(function (err) {
    handleStorageInitialization(err || null);
});
