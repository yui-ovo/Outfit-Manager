// A separate, text-only API. Never sends images, full prompts or API credentials
// to the main model. The caller owns the timeout for the whole selection cycle.
export function sceneApiConfig(meta) {
    const cfg = meta.apiScene || {};
    return Object.assign({}, cfg, cfg.reuseVision ? {
        endpoint: (meta.apiVision || {}).endpoint,
        key: (meta.apiVision || {}).key,
        model: (meta.apiVision || {}).model
    } : {});
}

export function sceneApiReady(meta) {
    const cfg = sceneApiConfig(meta);
    return !!(cfg.enabled && cfg.endpoint && cfg.endpoint.trim() && cfg.model && cfg.model.trim());
}

export function sceneApiEndpoint(raw) {
    let url;
    try { url = new URL((raw || '').trim()); } catch (e) { throw new Error('请填写有效的副 API 地址'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('副 API 地址格式不正确');
    url.hash = '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!url.pathname.endsWith('/chat/completions')) {
        if (!/\/v\d+$/.test(url.pathname)) url.pathname += '/v1';
        url.pathname += '/chat/completions';
    }
    return url.href;
}

export async function callSceneApi(cfg, system, data, signal) {
    const response = await fetch(sceneApiEndpoint(cfg.endpoint), {
        method: 'POST', __omInternal: true, signal,
        headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.key ? { Authorization: 'Bearer ' + cfg.key.trim() } : {}),
        body: JSON.stringify({ model: cfg.model.trim(), stream: false,
            messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(data) }], max_tokens: 1200 })
    });
    if (!response.ok) throw new Error('副 API 返回 HTTP ' + response.status);
    const result = await response.json();
    const content = result && result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content;
    if (typeof content !== 'string' || content.length > 24000) throw new Error('副 API 未返回有效文字结果');
    try {
        const answer = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
        if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error();
        return answer;
    } catch (e) { throw new Error('副 API 返回的 JSON 无效，已保留当前穿着'); }
}

export async function testSceneApi(meta) {
    const cfg = sceneApiConfig(meta);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const result = await callSceneApi(cfg, '只回复 JSON：{"ok":true}', { test: '连接与 JSON 格式测试' }, controller.signal);
        if (result.ok !== true) throw new Error('已连接，但模型未按要求返回 JSON');
    } catch (e) {
        if (controller.signal.aborted) throw new Error('连接超时，请检查地址和模型');
        throw e;
    } finally { clearTimeout(timer); }
}
