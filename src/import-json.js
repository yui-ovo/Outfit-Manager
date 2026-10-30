// Incremental JSON reader. Only a 256 KiB input slice and the current token are
// retained alongside the result; image values can be reduced before retention.
export function checkImportCancelled(signal) {
    if (signal && signal.aborted) {
        var error = new Error('已取消导入');
        error.name = 'AbortError';
        throw error;
    }
}

export function yieldImport() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

export async function readImportJson(file, options) {
    options = options || {};
    var chunkSize = options.chunkSize || 256 * 1024;
    var decoder = new TextDecoder('utf-8', { fatal: true });
    var stack = [], root, hasRoot = false;
    var token = null, pieces = [], escaped = false, stringKey = false;
    var tokenLength = 0, retainedLength = 0;
    function append(piece) {
        tokenLength += piece.length;
        if (tokenLength > (options.maxTokenLength || 32 * 1024 * 1024)) {
            throw new Error('单张图片或文本超过安全读取大小，请先缩小原图或拆分文件');
        }
        pieces.push(piece);
    }
    function fail() { throw new Error('文件不是有效的 JSON，未写入穿搭数据'); }
    function top() { return stack[stack.length - 1]; }
    function valueExpected() {
        var frame = top();
        return frame ? frame.state === 'value' || frame.state === 'firstValue' : !hasRoot;
    }
    function put(value) {
        var frame = top();
        if (!frame) { if (hasRoot) fail(); root = value; hasRoot = true; return; }
        if (!valueExpected()) fail();
        if (frame.array) frame.value.push(value);
        else Object.defineProperty(frame.value, frame.key, { value: value, writable: true, enumerable: true, configurable: true });
        frame.state = 'comma';
    }
    async function finishToken() {
        var raw = pieces.join('');
        pieces = [];
        tokenLength = 0;
        var value;
        try { value = JSON.parse(raw); } catch (e) { fail(); }
        raw = null;
        token = null;
        if (stringKey) { top().key = value; top().state = 'colon'; stringKey = false; return; }
        var frame = top();
        if (options.transformImage && typeof value === 'string' && value.indexOf('data:image/') === 0 && frame &&
            (frame.key === 'imageData' || frame.key === 'fabImage' || frame.assetMap)) {
            value = await options.transformImage(value);
            checkImportCancelled(options.signal);
        }
        if (typeof value === 'string') {
            retainedLength += value.length;
            if (retainedLength > (options.maxRetainedLength || 192 * 1024 * 1024)) {
                throw new Error('图片和文本总量仍过大，已停止以保护页面；请勾选压缩图片重试，或将分享文件拆成较小的文件');
            }
        }
        put(value);
    }
    for (var offset = 0; offset < file.size; offset += chunkSize) {
        checkImportCancelled(options.signal);
        var end = Math.min(file.size, offset + chunkSize);
        var text = decoder.decode(await file.slice(offset, end).arrayBuffer(), { stream: end < file.size });
        var i = 0;
        while (i < text.length) {
            if (token === 'string') {
                var start = i, closed = false;
                for (; i < text.length; i++) {
                    var c = text[i];
                    if (escaped) { escaped = false; continue; }
                    if (c === '\\') { escaped = true; continue; }
                    if (c === '"') { i++; closed = true; break; }
                }
                append(text.slice(start, i));
                if (closed) await finishToken();
                continue;
            }
            if (token === 'literal') {
                var begin = i;
                while (i < text.length && !/[\s,\]}]/.test(text[i])) i++;
                append(text.slice(begin, i));
                if (i < text.length) await finishToken();
                continue;
            }
            var ch = text[i++], frame = top();
            if (/^[\x20\t\r\n]$/.test(ch)) continue;
            if (ch === '"') {
                stringKey = !!(frame && !frame.array && (frame.state === 'key' || frame.state === 'firstKey'));
                if (!stringKey && !valueExpected()) fail();
                token = 'string'; pieces = []; tokenLength = 0; append('"'); escaped = false;
            } else if (ch === '{' || ch === '[') {
                if (!valueExpected() || stack.length >= 100) fail();
                var assetMap = !!(frame && frame.key === '_assets');
                var array = ch === '[';
                var value = array ? [] : {};
                put(value);
                stack.push({ value: value, array: array, state: array ? 'firstValue' : 'firstKey', key: null, assetMap: assetMap });
            } else if (ch === '}' || ch === ']') {
                if (!frame || frame.array !== (ch === ']') ||
                    (frame.state !== 'comma' && frame.state !== (frame.array ? 'firstValue' : 'firstKey'))) fail();
                stack.pop();
            } else if (ch === ':') {
                if (!frame || frame.state !== 'colon') fail();
                frame.state = 'value';
            } else if (ch === ',') {
                if (!frame || frame.state !== 'comma') fail();
                frame.state = frame.array ? 'value' : 'key';
            } else {
                if (!valueExpected() || !/[-0-9tfn]/.test(ch)) fail();
                token = 'literal'; pieces = []; tokenLength = 0; append(ch); stringKey = false;
            }
        }
        if (options.onProgress) options.onProgress(end, file.size);
        await yieldImport();
    }
    if (token === 'literal') await finishToken();
    if (token || stack.length || !hasRoot) fail();
    checkImportCancelled(options.signal);
    return root;
}

// Opt-in static image reduction, one decoded image at a time. PNG keeps alpha;
// animated GIF/SVG and undecodable images retain their original data.
export function shrinkImportImage(dataUrl) {
    if (!/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(dataUrl)) return Promise.resolve(dataUrl);
    return new Promise(function (resolve) {
        var img = new Image();
        function finish(value) { img.onload = img.onerror = null; img.src = ''; resolve(value); }
        img.onerror = function () { finish(dataUrl); };
        img.onload = function () {
            var canvas;
            try {
                var scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
                canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                var mime = /^data:image\/jpe?g;/i.test(dataUrl) ? 'image/jpeg' : 'image/png';
                var reduced = canvas.toDataURL(mime, 0.82);
                finish(reduced.length < dataUrl.length ? reduced : dataUrl);
            } catch (e) { finish(dataUrl); }
            finally { if (canvas) { canvas.width = 0; canvas.height = 0; } }
        };
        img.src = dataUrl;
    });
}
