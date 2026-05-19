/**
 * Cursor2API v2 - 鍏ュ彛
 *
 * 灏?Cursor 鏂囨。椤靛厤璐?AI 鎺ュ彛浠ｇ悊涓?Anthropic Messages API
 * 閫氳繃鎻愮ず璇嶆敞鍏ヨ Claude Code 鎷ユ湁瀹屾暣宸ュ叿璋冪敤鑳藉姏
 */

import 'dotenv/config';
import { createRequire } from 'module';
import express from 'express';
import { ensureCursorAuth, hasVcrcsCookie, logCursorAuthStatus } from './cursor-auth.js';
import { isCloudAgentEnabled } from './cursor-cloud-agent.js';
import { getConfig, initConfigWatcher, stopConfigWatcher } from './config.js';
import { handleMessages, listModels, countTokens } from './handler.js';
import { handleOpenAIChatCompletions, handleOpenAIResponses } from './openai-handler.js';
import { serveLogViewer, apiGetLogs, apiGetRequests, apiGetStats, apiGetVueStats, apiGetPayload, apiLogsStream, serveLogViewerLogin, apiClearLogs, serveVueApp, apiGetRequestsMore } from './log-viewer.js';
import { apiGetConfig, apiSaveConfig } from './config-api.js';
import { loadLogsFromFiles } from './logger.js';
import { initDb } from './logger-db.js';

// 浠?package.json 璇诲彇鐗堟湰鍙凤紝缁熶竴鏉ユ簮锛岄伩鍏嶅澶勭‖缂栫爜
const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };


const app = express();
let config = getConfig();

// Parse JSON body.
app.use(express.json({ limit: '50mb' }));

// CORS
app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (_req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

// 鈽?闈欐€佹枃浠惰矾鐢憋紙鏃犻渶閴存潈锛孋SS/JS 绛夛級
app.use('/public', express.static('public'));

// Log viewer auth middleware.
const logViewerAuth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const tokens = getConfig().authTokens;
    if (!tokens || tokens.length === 0) return next(); // 鏈厤缃?token 鍒欐斁琛?
    // 鏀寔澶氱浼犲叆鏂瑰紡: query ?token=xxx, Authorization header, x-api-key header
    const tokenFromQuery = req.query.token as string | undefined;
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    const tokenFromHeader = authHeader ? String(authHeader).replace(/^Bearer\s+/i, '').trim() : undefined;
    const token = tokenFromQuery || tokenFromHeader;

    if (!token || !tokens.includes(token)) {
        // HTML 椤甸潰璇锋眰 鈫?杩斿洖鐧诲綍椤? API 璇锋眰 鈫?杩斿洖 JSON 閿欒
        if (req.path === '/logs') {
            return serveLogViewerLogin(req, res);
        }
        res.status(401).json({ error: { message: 'Unauthorized. Provide token via ?token=xxx or Authorization header.', type: 'auth_error' } });
        return;
    }
    next();
};

// 鈽?鏃ュ織鏌ョ湅鍣ㄨ矾鐢憋紙甯﹂壌鏉冿級
app.get('/logs', logViewerAuth, serveLogViewer);
// Vue3 log UI.
app.get('/vuelogs', serveVueApp);
app.get('/api/logs', logViewerAuth, apiGetLogs);
app.get('/api/requests/more', logViewerAuth, apiGetRequestsMore);
app.get('/api/requests', logViewerAuth, apiGetRequests);
app.get('/api/stats', logViewerAuth, apiGetStats);
app.get('/api/vue/stats', logViewerAuth, apiGetVueStats);
app.get('/api/payload/:requestId', logViewerAuth, apiGetPayload);
app.get('/api/logs/stream', logViewerAuth, apiLogsStream);
app.post('/api/logs/clear', logViewerAuth, apiClearLogs);
app.get('/api/config', logViewerAuth, apiGetConfig);
app.post('/api/config', logViewerAuth, apiSaveConfig);

// 鈽?API 閴存潈涓棿浠讹細閰嶇疆浜?authTokens 鍒欓渶瑕?Bearer token
app.use((req, res, next) => {
    if (req.method === 'GET' || req.path === '/health') {
        return next();
    }
    const tokens = getConfig().authTokens;
    if (!tokens || tokens.length === 0) {
        return next();
    }
    const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
    if (!authHeader) {
        res.status(401).json({ error: { message: 'Missing authentication token. Use Authorization: Bearer <token>', type: 'auth_error' } });
        return;
    }
    const token = String(authHeader).replace(/^Bearer\s+/i, '').trim();
    if (!tokens.includes(token)) {
        console.log(`[Auth] 鎷掔粷鏃犳晥 token: ${token.substring(0, 8)}...`);
        res.status(403).json({ error: { message: 'Invalid authentication token', type: 'auth_error' } });
        return;
    }
    next();
});

// ==================== 璺敱 ====================

// Anthropic Messages API
app.post('/v1/messages', handleMessages);
app.post('/messages', handleMessages);

// OpenAI Chat Completions API锛堝吋瀹癸級
app.post('/v1/chat/completions', handleOpenAIChatCompletions);
app.post('/chat/completions', handleOpenAIChatCompletions);

// OpenAI Responses API.
app.post('/v1/responses', handleOpenAIResponses);
app.post('/responses', handleOpenAIResponses);

// Token 璁℃暟
app.post('/v1/messages/count_tokens', countTokens);
app.post('/messages/count_tokens', countTokens);

// OpenAI 鍏煎妯″瀷鍒楄〃
app.get('/v1/models', listModels);

// Health check.
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
});

// Root route.
app.get('/', (_req, res) => {
    res.json({
        name: 'cursor2api',
        version: VERSION,
        description: 'Cursor Docs AI -> Anthropic & OpenAI & Cursor IDE API Proxy',
        endpoints: {
            anthropic_messages: 'POST /v1/messages',
            openai_chat: 'POST /v1/chat/completions',
            openai_responses: 'POST /v1/responses',
            models: 'GET /v1/models',
            health: 'GET /health',
            log_viewer: 'GET /logs',
            log_viewer_vue: 'GET /vuelogs',
        },
        usage: {
            claude_code: 'export ANTHROPIC_BASE_URL=http://localhost:' + config.port,
            openai_compatible: 'OPENAI_BASE_URL=http://localhost:' + config.port + '/v1',
            cursor_ide: 'OPENAI_BASE_URL=http://localhost:' + config.port + '/v1 (use a Claude model)',
        },
    });
});

// ==================== 鍚姩 ====================

// Initialize SQLite when enabled.
if (config.logging?.db_enabled) {
    initDb(config.logging.db_path || './logs/cursor2api.db');
}

// Load persisted logs before listen.
loadLogsFromFiles();

async function verifyStealthProxy(url: string): Promise<void> {
    const healthUrl = `${url.replace(/\/$/, '')}/health`;
    try {
        const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
        const body = (await resp.json()) as { status?: string };
        if (body.status === 'ok') return;
        console.error(`[Cursor] stealth-proxy 鏈氨缁?(${healthUrl} 鈫?status=${body.status ?? 'unknown'})`);
        console.error('[Cursor] 璇风瓑寰?dev-stealth 鍑虹幇銆宻tealth-proxy 宸插氨缁€嶏紝鎴栨煡鐪?stealth-proxy-startup.log');
        process.exit(1);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[Cursor] 鏃犳硶杩炴帴 stealth-proxy: ${healthUrl}`);
        console.error(`[Cursor]   ${msg}`);
        console.error('[Cursor] 请先运行: npm run dev:stealth:win');
        process.exit(1);
    }
}

async function startServer() {
    config = getConfig();
    if (config.cloudAgent?.enabled && !config.apiKey?.trim()) {
        console.error('[Cursor] cloud_agent.enabled 已开启，但未配置 CURSOR_API_KEY（crsr_ Dashboard API Key）');
    }
    logCursorAuthStatus(config);
    if (config.stealthProxy) {
        await verifyStealthProxy(config.stealthProxy);
    } else {
        await ensureCursorAuth(config);
    }
    logCursorAuthStatus(config);

const server = app.listen(config.port, '0.0.0.0', () => {
    const auth = config.authTokens?.length ? `${config.authTokens.length} token(s)` : 'open';
    const logParts: string[] = [];
    if (config.logging?.file_enabled) logParts.push(`file(${config.logging.persist_mode || 'summary'}) -> ${config.logging.dir}`);
    if (config.logging?.db_enabled) logParts.push(`sqlite -> ${config.logging.db_path || './logs/cursor2api.db'}`);
    const logPersist = logParts.length > 0 ? logParts.join(' + ') : 'memory only';
    
    // Tools 閰嶇疆鎽樿
    const toolsCfg = config.tools;
    let toolsInfo = 'default (full, desc=full)';
    if (toolsCfg) {
        if (toolsCfg.disabled) {
            toolsInfo = '\x1b[33mdisabled\x1b[0m (tool definitions disabled)';
        } else if (toolsCfg.passthrough) {
            toolsInfo = '\x1b[36mpassthrough\x1b[0m (raw JSON passthrough)';
        } else {
            const parts: string[] = [];
            parts.push(`schema=${toolsCfg.schemaMode}`);
            parts.push(toolsCfg.descriptionMaxLength === 0 ? 'desc=full' : `desc<=${toolsCfg.descriptionMaxLength}`);
            if (toolsCfg.includeOnly?.length) parts.push(`whitelist=${toolsCfg.includeOnly.length}`);
            if (toolsCfg.exclude?.length) parts.push(`blacklist=${toolsCfg.exclude.length}`);
            toolsInfo = parts.join(', ');
        }
    }
    
    console.log('');
    console.log(`  \x1b[36mCursor2API v${VERSION}\x1b[0m`);
    console.log(`  |- Server:  \x1b[32mhttp://localhost:${config.port}\x1b[0m`);
    console.log(`  |- Model:   ${config.cursorModel}`);
    const cursorAuth = isCloudAgentEnabled(config)
        ? `cloud-agent -> ${config.cloudAgent!.model}`
        : config.apiKey
        ? 'api-key only'
        : config.stealthProxy
            ? `stealth -> ${config.stealthProxy}`
            : config.cookie
                ? hasVcrcsCookie(config.cookie)
                    ? 'cookie + _vcrcs'
                    : 'cookie (missing _vcrcs, may 403)'
                : 'none - need CURSOR_API_KEY / CURSOR_SESSION_TOKEN / CURSOR_COOKIE or stealth';
    console.log(`  |- Cursor:  ${cursorAuth}`);
    console.log(`  |- Auth:    ${auth}`);
    console.log(`  |- Tools:   ${toolsInfo}`);
    console.log(`  |- Logging: ${logPersist}`);
    console.log(`  \\- Logs:    \x1b[35mhttp://localhost:${config.port}/logs\x1b[0m`);
    console.log(`  \\- Logs Vue3: \x1b[35mhttp://localhost:${config.port}/vuelogs\x1b[0m`);
    console.log('');

    initConfigWatcher();
});

server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Server] 端口 ${config.port} 已被占用，请修改 .env 的 PORT 或 config.yaml 的 port`);
    } else {
        console.error('[Server] 启动失败:', err.message);
    }
    process.exit(1);
});
}

startServer().catch((e) => {
    console.error('[Server] Startup failed:', e);
    process.exit(1);
});

process.on('SIGTERM', () => {
    stopConfigWatcher();
    process.exit(0);
});
process.on('SIGINT', () => {
    stopConfigWatcher();
    process.exit(0);
});
