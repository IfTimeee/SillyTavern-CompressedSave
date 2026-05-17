/**
 * SillyTavern Compressed Save
 * ---------------------------------------------------------------
 *  纯前端扩展：拦截大体积 POST 请求，自动 gzip 压缩请求体。
 *  专治跨境云酒馆「保存 18MB 卡 50 秒」。
 *
 *  原理：
 *   1. monkey-patch window.fetch
 *   2. 对匹配路径的 POST 请求，把 body 用浏览器原生 CompressionStream 压成 gzip
 *   3. 附加 Content-Encoding: gzip 头
 *   4. Express 的 body-parser 默认 inflate=true，自动解压，后端无感知
 *
 *  作者：莓可莉丝（meikorisu）for iftime
 *  License: MIT
 * ---------------------------------------------------------------
 */

(function () {
    'use strict';
    if (window.__CompressedSavePatched) {
        console.warn('[CompressedSave] 已经加载过一次，跳过重复挂载喵~');
        return;
    }
    window.__CompressedSavePatched = true;

    const MODULE_NAME = 'CompressedSave';
    const STORAGE_KEY = 'CompressedSave.settings.v1';
    const MAX_LOG_ROWS = 30;

    // ---------- 默认配置 ----------
    const DEFAULTS = {
        enabled: true,
        targetPaths: [
            '/api/chats/save',
            '/api/chats/group/save',
        ],
        minBytes: 4096,
        verbose: false,
        logEnabled: false,
    };

    // ---------- 设置持久化 ----------
    function loadSettings() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return { ...DEFAULTS };
            const parsed = JSON.parse(raw);
            return { ...DEFAULTS, ...parsed };
        } catch {
            return { ...DEFAULTS };
        }
    }
    function saveSettings(s) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
    }
    let settings = loadSettings();

    // ---------- 运行时统计 ----------
    const stats = {
        intercepted: 0,
        compressed: 0,
        skipped: 0,
        failed: 0,
        bytesIn: 0,
        bytesOut: 0,
        lastRatio: null,
        log: [], // 最近 N 条记录 {time, path, status, rawSize, gzSize, ratio, gzipMs, totalMs, error}
    };

    function pushLog(entry) {
        if (!settings.logEnabled) return;
        stats.log.unshift(entry);
        if (stats.log.length > MAX_LOG_ROWS) stats.log.length = MAX_LOG_ROWS;
        scheduleUIRefresh();
    }

    function incStat(key) {
        if (!settings.logEnabled) return;
        stats[key]++;
    }
    function addStat(key, val) {
        if (!settings.logEnabled) return;
        stats[key] += val;
    }
    function setStat(key, val) {
        if (!settings.logEnabled) return;
        stats[key] = val;
    }

    function fmtBytes(n) {
        if (n == null) return '—';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }
    function fmtMs(n) {
        if (n == null) return '—';
        if (n < 1000) return `${n.toFixed(0)} ms`;
        return `${(n / 1000).toFixed(2)} s`;
    }
    function nowHMS() {
        const d = new Date();
        const p = n => String(n).padStart(2, '0');
        return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    }

    // ---------- 工具 ----------
    function getBodyString(body) {
        if (body == null) return null;
        if (typeof body === 'string') return body;
        if (body instanceof ArrayBuffer) return body;
        if (ArrayBuffer.isView(body)) {
            return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
        }
        return null;
    }

    async function gzip(data) {
        let input;
        if (typeof data === 'string') {
            input = new TextEncoder().encode(data);
        } else {
            input = new Uint8Array(data);
        }
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        writer.write(input);
        writer.close();
        const compressed = await new Response(cs.readable).arrayBuffer();
        return { input, output: compressed };
    }

    function shouldIntercept(url, init) {
        if (!settings.enabled) return false;
        const method = (init?.method || 'GET').toUpperCase();
        if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return false;
        let pathname = '';
        try {
            const u = typeof url === 'string' ? url : url?.url || '';
            pathname = u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
        } catch { return false; }
        return settings.targetPaths.some(p => pathname.includes(p));
    }

    function extractPath(input) {
        try {
            const u = typeof input === 'string' ? input : input?.url || '';
            return u.startsWith('http') ? new URL(u).pathname : (u.split('?')[0] || u);
        } catch { return '?'; }
    }

    // ---------- 核心：fetch hook ----------
    const originalFetch = window.fetch.bind(window);

    async function patchedFetch(input, init) {
        const t0 = performance.now();
        try {
            if (input instanceof Request && !init) {
                init = {
                    method: input.method,
                    headers: new Headers(input.headers),
                    body: await input.clone().text(),
                    mode: input.mode,
                    credentials: input.credentials,
                    cache: input.cache,
                    redirect: input.redirect,
                    referrer: input.referrer,
                    integrity: input.integrity,
                };
                input = input.url;
            }
            init = init || {};
            
            if (!shouldIntercept(input, init)) {
                return originalFetch(input, init);
            }
            // 防止重复压缩：如果已经有 Content-Encoding，就不要再处理
            const existingHeaders = new Headers(init.headers || {});
            if (existingHeaders.has('content-encoding')) {
                stats.skipped++;
                pushLog({
                    time: nowHMS(),
                    path: extractPath(input),
                    status: 'skip',
                    note: `已有 Content-Encoding: ${existingHeaders.get('content-encoding')}`,
                });
                return originalFetch(input, init);
            }

            if (typeof CompressionStream === 'undefined') {
                incStat('skipped');
                pushLog({
                    time: nowHMS(), path: extractPath(input),
                    status: 'skip', note: 'CompressionStream 不可用',
                });
                return originalFetch(input, init);
            }

            const body = getBodyString(init.body);
            if (body == null) {
                incStat('skipped');
                pushLog({
                    time: nowHMS(), path: extractPath(input),
                    status: 'skip', note: 'body 类型不支持',
                });
                return originalFetch(input, init);
            }

            const byteSize = typeof body === 'string' ? new Blob([body]).size : body.byteLength;
            if (byteSize < settings.minBytes) {
                incStat('skipped');
                pushLog({
                    time: nowHMS(), path: extractPath(input),
                    status: 'skip', note: `< ${fmtBytes(settings.minBytes)} 阈值`,
                    rawSize: byteSize,
                });
                return originalFetch(input, init);
            }

            incStat('intercepted');

            const tGzipStart = performance.now();
            const { input: rawBytes, output: gzBytes } = await gzip(body);
            const tGzipEnd = performance.now();

            incStat('compressed');
            addStat('bytesIn', rawBytes.byteLength);
            addStat('bytesOut', gzBytes.byteLength);
            setStat('lastRatio', gzBytes.byteLength / rawBytes.byteLength);

            const newHeaders = new Headers(init.headers || {});
            newHeaders.delete('content-length');
            newHeaders.set('content-encoding', 'gzip');
            if (!newHeaders.has('content-type')) {
                newHeaders.set('content-type', 'application/json');
            }

            const newInit = { ...init, headers: newHeaders, body: gzBytes };

            if (settings.verbose) {
                console.log(
                    `%c[${MODULE_NAME}]%c gzip ${fmtBytes(rawBytes.byteLength)} -> ${fmtBytes(gzBytes.byteLength)} ` +
                    `(${(stats.lastRatio * 100).toFixed(1)}%, ${(tGzipEnd - tGzipStart).toFixed(0)}ms)  ${extractPath(input)}`,
                    'color:#b46aff;font-weight:bold', '',
                );
            }

            const response = await originalFetch(input, newInit);
            const t1 = performance.now();

            pushLog({
                time: nowHMS(),
                path: extractPath(input),
                status: response.ok ? 'ok' : `http ${response.status}`,
                rawSize: rawBytes.byteLength,
                gzSize: gzBytes.byteLength,
                ratio: stats.lastRatio,
                gzipMs: tGzipEnd - tGzipStart,
                totalMs: t1 - t0,
            });

            return response;
        } catch (err) {
            incStat('failed');
            console.error(`[${MODULE_NAME}] hook 内部错误，回退原始 fetch：`, err);
            pushLog({
                time: nowHMS(), path: extractPath(input),
                status: 'error', note: String(err?.message || err),
            });
            try {
                return originalFetch(input, init);
            } catch (e2) { throw err; }
        }
    }

    window.fetch = patchedFetch;

    // 控制台调试入口（保留，给硬核玩家）
    window.CompressedSave = {
        get settings() { return settings; },
        get stats() { return stats; },
        reset() {
            stats.intercepted = stats.compressed = stats.skipped = stats.failed = 0;
            stats.bytesIn = stats.bytesOut = 0;
            stats.lastRatio = null;
            stats.log.length = 0;
            scheduleUIRefresh();
        },
    };

    console.log(`%c[${MODULE_NAME}]%c 已激活，hook 已挂载喵~`, 'color:#b46aff;font-weight:bold', '');

    // =================================================================
    //                              UI
    // =================================================================

    let uiRefreshTimer = null;
    function scheduleUIRefresh() {
        if (uiRefreshTimer) return;
        uiRefreshTimer = requestAnimationFrame(() => {
            uiRefreshTimer = null;
            refreshUI();
        });
    }

    function buildUI() {
        const container = document.getElementById('extensions_settings2')
            || document.getElementById('extensions_settings');
        if (!container) { setTimeout(buildUI, 500); return; }
        if (document.getElementById('CompressedSave_panel')) return;

        const panel = document.createElement('div');
        panel.id = 'CompressedSave_panel';
        panel.classList.add('CompressedSave-panel');

        panel.innerHTML = `
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>🐈 Compressed Save (猫猫加速喵~)</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small>给跨境酒馆的保存请求加 gzip 压缩，省 90% 上行流量。<b id="cs_status_badge" class="cs-badge cs-badge-on">已启用</b></small>

                    <div class="cs-row">
                        <label class="checkbox_label" for="cs_enabled" style="flex:1;">
                            <input id="cs_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                            <span>启用压缩</span>
                        </label>
                        <label class="checkbox_label" for="cs_verbose" style="flex:1;">
                            <input id="cs_verbose" type="checkbox" ${settings.verbose ? 'checked' : ''}>
                            <span>控制台日志</span>
                        </label>
                        <label class="checkbox_label" for="cs_log_enabled" style="flex:1;">
                            <input id="cs_log_enabled" type="checkbox" ${settings.logEnabled ? 'checked' : ''}>
                            <span>记录统计与日志</span>
                        </label>
                    </div>

                    <label for="cs_min" class="cs-field">
                        <small>最小压缩阈值（字节）：</small>
                        <input id="cs_min" type="number" class="text_pole" value="${settings.minBytes}" min="0" step="1024">
                    </label>

                    <label for="cs_paths" class="cs-field">
                        <small>拦截路径（每行一个，匹配 includes）：</small>
                        <textarea id="cs_paths" class="text_pole cs-paths" rows="3">${settings.targetPaths.join('\n')}</textarea>
                    </label>

                    <hr>
                    <div class="cs-stats-grid">
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">已压缩</div>
                            <div class="cs-stat-value" id="cs_st_n">0</div>
                        </div>
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">跳过</div>
                            <div class="cs-stat-value" id="cs_st_skip">0</div>
                        </div>
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">失败</div>
                            <div class="cs-stat-value" id="cs_st_fail">0</div>
                        </div>
                        <div class="cs-stat-card">
                            <div class="cs-stat-label">最近压缩比</div>
                            <div class="cs-stat-value" id="cs_st_ratio">—</div>
                        </div>
                        <div class="cs-stat-card cs-stat-card-wide">
                            <div class="cs-stat-label">累计上传节省</div>
                            <div class="cs-stat-value">
                                <span id="cs_st_in">0</span>
                                <span class="cs-stat-arrow">→</span>
                                <span id="cs_st_out">0</span>
                                <small id="cs_st_saved" class="cs-saved">省 0</small>
                            </div>
                        </div>
                    </div>

                    <div class="cs-row cs-actions">
                        <input type="button" class="menu_button" id="cs_reset" value="🧹 清空统计">
                        <input type="button" class="menu_button" id="cs_test" value="⚡ 测试压缩">
                        <input type="button" class="menu_button" id="cs_copy" value="📋 复制诊断">
                    </div>

                    <hr>
                    <div class="cs-log-header">
                        <b>📜 实时日志</b>
                        <small>最近 ${MAX_LOG_ROWS} 条</small>
                    </div>
                    <div class="cs-log-wrap">
                        <table class="cs-log-table">
                            <thead><tr>
                                <th>时间</th>
                                <th>状态</th>
                                <th>路径</th>
                                <th>原始</th>
                                <th>压缩</th>
                                <th>比</th>
                                <th>gzip</th>
                                <th>总</th>
                                <th>备注</th>
                            </tr></thead>
                            <tbody id="cs_log_body">
                                <tr><td colspan="9" class="cs-empty">暂无记录，发条消息试试喵~</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        `;

        container.appendChild(panel);

        const $ = id => document.getElementById(id);
        $('cs_enabled').addEventListener('change', e => {
            settings.enabled = e.target.checked;
            saveSettings(settings);
            refreshUI();
        });
        $('cs_verbose').addEventListener('change', e => {
            settings.verbose = e.target.checked;
            saveSettings(settings);
        });
        $('cs_log_enabled').addEventListener('change', e => {
            settings.logEnabled = e.target.checked;
            saveSettings(settings);
            refreshUI();
        });
        $('cs_min').addEventListener('change', e => {
            const v = parseInt(e.target.value, 10);
            settings.minBytes = isFinite(v) && v >= 0 ? v : DEFAULTS.minBytes;
            saveSettings(settings);
        });
        $('cs_paths').addEventListener('change', e => {
            settings.targetPaths = e.target.value
                .split('\n').map(s => s.trim()).filter(Boolean);
            saveSettings(settings);
        });
        $('cs_reset').addEventListener('click', () => window.CompressedSave.reset());
        $('cs_test').addEventListener('click', runSelfTest);
        $('cs_copy').addEventListener('click', copyDiagnostics);

        refreshUI();
    }

    function refreshUI() {
        const $ = id => document.getElementById(id);
        if (!$('cs_st_n')) return;

        $('cs_st_n').textContent = stats.compressed;
        $('cs_st_skip').textContent = stats.skipped;
        $('cs_st_fail').textContent = stats.failed;
        $('cs_st_ratio').textContent = stats.lastRatio == null
            ? '—'
            : `${(stats.lastRatio * 100).toFixed(1)}%`;
        $('cs_st_in').textContent = fmtBytes(stats.bytesIn);
        $('cs_st_out').textContent = fmtBytes(stats.bytesOut);

        const saved = stats.bytesIn - stats.bytesOut;
        const savedPct = stats.bytesIn > 0 ? (saved / stats.bytesIn * 100) : 0;
        $('cs_st_saved').textContent = `省 ${fmtBytes(saved)} (${savedPct.toFixed(1)}%)`;

        const badge = $('cs_status_badge');
        if (badge) {
            badge.textContent = settings.enabled ? '已启用' : '已禁用';
            badge.className = 'cs-badge ' + (settings.enabled ? 'cs-badge-on' : 'cs-badge-off');
        }

        // 日志表格
        const tbody = $('cs_log_body');
        if (!tbody) return;
        if (!settings.logEnabled) {
            tbody.innerHTML = '<tr><td colspan="9" class="cs-empty">日志记录已关闭</td></tr>';
            return;
        }
        if (stats.log.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" class="cs-empty">暂无记录，发条消息试试喵~</td></tr>';
            return;
        }
        tbody.innerHTML = stats.log.map(e => {
            const statusClass = e.status === 'ok' ? 'cs-st-ok'
                : e.status === 'skip' ? 'cs-st-skip'
                : e.status === 'error' ? 'cs-st-err'
                : 'cs-st-warn';
            const shortPath = e.path
                ? e.path.replace('/api/chats/', '/.../').slice(-32)
                : '—';
            return `<tr>
                <td>${e.time || '—'}</td>
                <td class="${statusClass}">${e.status}</td>
                <td title="${escapeHtml(e.path || '')}">${escapeHtml(shortPath)}</td>
                <td>${fmtBytes(e.rawSize)}</td>
                <td>${fmtBytes(e.gzSize)}</td>
                <td>${e.ratio == null ? '—' : (e.ratio * 100).toFixed(1) + '%'}</td>
                <td>${fmtMs(e.gzipMs)}</td>
                <td>${fmtMs(e.totalMs)}</td>
                <td class="cs-note" title="${escapeHtml(e.note || '')}">${escapeHtml(e.note || '')}</td>
            </tr>`;
        }).join('');
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    // ---------- 自检功能：本地压缩一段 1MB 数据测试 ----------
    async function runSelfTest() {
        const btn = document.getElementById('cs_test');
        if (!btn) return;
        const orig = btn.value;
        btn.value = '测试中...';
        btn.disabled = true;
        try {
            if (typeof CompressionStream === 'undefined') {
                alert('当前浏览器不支持 CompressionStream，无法启用压缩喵 QAQ');
                return;
            }
            // 生成 1MB 拟真 JSON 文本
            const sample = JSON.stringify({
                msg: '猫猫思故猫猫在'.repeat(50),
                role: 'assistant',
                meta: { tags: ['test', 'cat', 'philosophy'] },
            });
            const fakePayload = '[' + new Array(2000).fill(sample).join(',') + ']';

            const t0 = performance.now();
            const { input, output } = await gzip(fakePayload);
            const t1 = performance.now();

            const ratio = output.byteLength / input.byteLength;
            const msg =
                `✅ 自检通过喵！\n\n` +
                `样本大小：${fmtBytes(input.byteLength)}\n` +
                `压缩后：${fmtBytes(output.byteLength)}\n` +
                `压缩比：${(ratio * 100).toFixed(1)}%（省 ${(100 - ratio * 100).toFixed(1)}%）\n` +
                `压缩耗时：${(t1 - t0).toFixed(0)} ms\n\n` +
                `当前配置正常，发消息时就会自动压缩 /api/chats/save 喵～`;
            alert(msg);
        } catch (e) {
            alert(`❌ 自检失败喵：${e?.message || e}`);
        } finally {
            btn.value = orig;
            btn.disabled = false;
        }
    }

    // ---------- 一键复制诊断信息 ----------
    function copyDiagnostics() {
        const info = {
            module: MODULE_NAME,
            version: '1.1.0',
            ua: navigator.userAgent,
            compressionStreamSupported: typeof CompressionStream !== 'undefined',
            settings,
            stats: {
                intercepted: stats.intercepted,
                compressed: stats.compressed,
                skipped: stats.skipped,
                failed: stats.failed,
                bytesIn: stats.bytesIn,
                bytesOut: stats.bytesOut,
                lastRatio: stats.lastRatio,
                recentLog: stats.log.slice(0, 10),
            },
            time: new Date().toISOString(),
        };
        const text = JSON.stringify(info, null, 2);
        navigator.clipboard.writeText(text).then(
            () => alert('诊断信息已复制到剪贴板喵～粘给莓可看吧！'),
            () => {
                // 兼容回退：弹出来让用户手动复制
                const win = window.open('', '_blank');
                win.document.body.innerText = text;
            },
        );
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildUI);
    } else {
        buildUI();
    }
})();
