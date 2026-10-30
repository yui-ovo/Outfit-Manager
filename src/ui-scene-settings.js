import { loadMeta, saveMeta } from './db.js';
import { defMeta } from './data.js';
import { sceneApiConfig, testSceneApi } from './scene-api.js';
import { cancelScenePreparation } from './scene-wardrobe.js';
import { openModelPicker } from './api.js';
import { esc, toast } from './utils.js';

export function sceneSettingsHtml() {
    const cfg = Object.assign({}, defMeta().apiScene, loadMeta().apiScene);
    const field = (id, title, type, value, placeholder) => '<div class="om-setting-row"><label>' + title + '</label>' +
        '<input id="om-scene-' + id + '" type="' + type + '" value="' + esc(String(value)) + '" placeholder="' + placeholder +
        '" style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid rgba(127,127,127,.2);background:rgba(127,127,127,.08);color:inherit;font:inherit" /></div>';
    return '<div class="om-divider"></div><div class="om-sec-title">场景换装副 API</div>' +
        '<div class="om-hint">先由副 API 判断是否换衣、挑选合适衣服，主 API 只接收当前穿着。请长按分类加入场景衣柜。副 API 会收到最近 6 条对话（每条最多 2000 字）、当前穿着和候选衣服文字；不发图片。支持兼容 Chat Completions 的接口，普通文字模型即可。</div>' +
        '<div class="om-setting-row om-row-inline"><label>启用副 API 自动换装</label><input id="om-scene-enabled" class="om-chk" type="checkbox"' + (cfg.enabled ? ' checked' : '') + ' /></div>' +
        '<div class="om-setting-row om-row-inline"><label>复用描述生成 API 的地址、Key 和模型</label><input id="om-scene-reuse" class="om-chk" type="checkbox"' + (cfg.reuseVision ? ' checked' : '') + ' /></div>' +
        '<div id="om-scene-custom"' + (cfg.reuseVision ? ' hidden' : '') + '>' +
        field('endpoint', '副 API 地址', 'text', cfg.endpoint, '中转站地址或完整 /chat/completions 地址') +
        field('key', '副 API Key', 'password', cfg.key, 'sk-...') +
        field('model', '模型名称', 'text', cfg.model, '填写文字模型 ID') +
        '<button class="om-btn om-btn-outline" id="om-scene-model-fetch">拉取副 API 模型</button></div>' +
        field('timeout', '最多等待秒数（5–60，超时沿用当前穿着）', 'number', cfg.timeoutSeconds, '20') +
        '<div class="om-btn-row"><button class="om-btn om-btn-outline" id="om-scene-test">测试副 API 连接</button></div>' +
        '<div class="om-hint" id="om-scene-test-result" style="margin-top:8px" aria-live="polite">每个新回合先判断一次；实际换装时再筛选候选。会增加副 API 用量和等待时间。关闭此开关后仍可手动随机。</div>';
}

export function bindSceneSettings(sheet) {
    function save(field, value) {
        cancelScenePreparation();
        const meta = loadMeta();
        meta.apiScene = Object.assign({}, defMeta().apiScene, meta.apiScene, { [field]: value });
        saveMeta(meta);
    }
    for (const name of ['endpoint', 'key', 'model']) {
        sheet.querySelector('#om-scene-' + name).addEventListener('input', function () { save(name, this.value.trim()); });
    }
    sheet.querySelector('#om-scene-enabled').addEventListener('change', function () { save('enabled', this.checked); });
    sheet.querySelector('#om-scene-reuse').addEventListener('change', function () {
        save('reuseVision', this.checked);
        sheet.querySelector('#om-scene-custom').hidden = this.checked;
    });
    const timeout = sheet.querySelector('#om-scene-timeout');
    timeout.min = 5; timeout.max = 60;
    timeout.addEventListener('change', function () {
        const value = Math.max(5, Math.min(60, Number(this.value) || 20));
        this.value = value; save('timeoutSeconds', value);
    });
    sheet.querySelector('#om-scene-model-fetch').addEventListener('click', () => {
        const cfg = sceneApiConfig(loadMeta());
        if (!cfg.endpoint) { toast('请先填写副 API 地址', true); return; }
        openModelPicker(cfg, model => { save('model', model); sheet.querySelector('#om-scene-model').value = model; });
    });
    sheet.querySelector('#om-scene-test').addEventListener('click', async function () {
        const result = sheet.querySelector('#om-scene-test-result');
        this.disabled = true; result.textContent = '正在测试副 API…';
        try { await testSceneApi(loadMeta()); result.textContent = '连接成功，模型可返回换装所需的 JSON。'; }
        catch (e) { result.textContent = e.message || '测试失败'; }
        finally { this.disabled = false; }
    });
}
