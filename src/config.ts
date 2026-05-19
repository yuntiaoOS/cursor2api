import { readFileSync, existsSync, watch, type FSWatcher } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolveCursorCookie } from './cursor-auth.js';
import type { AppConfig, CloudAgentConfig } from './types.js';

let config: AppConfig;
let watcher: FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// 閰嶇疆鍙樻洿鍥炶皟
type ConfigReloadCallback = (newConfig: AppConfig, changes: string[]) => void;
const reloadCallbacks: ConfigReloadCallback[] = [];

/**
 * 娉ㄥ唽閰嶇疆鐑噸杞藉洖璋?
 */
export function onConfigReload(cb: ConfigReloadCallback): void {
    reloadCallbacks.push(cb);
}

function defaultCloudAgentConfig(): CloudAgentConfig {
    return {
        enabled: false,
        apiBase: 'https://api.cursor.com/v1',
        model: 'composer-2.5',
        readTimeoutSec: 300,
        agentBusyRetries: 15,
        agentBusyDelaySec: 2,
        streamResumeRetries: 5,
        sessionTtlSec: 86400,
    };
}

function ensureCloudAgent(cfg: AppConfig): CloudAgentConfig {
    if (!cfg.cloudAgent) cfg.cloudAgent = defaultCloudAgentConfig();
    return cfg.cloudAgent;
}

function parseCloudAgentYaml(yaml: Record<string, unknown>, result: AppConfig): void {
    const ca = yaml.cloud_agent as Record<string, unknown> | undefined;
    if (!ca) return;
    const envTypeRaw = ca.env_type != null ? String(ca.env_type).trim().toLowerCase() : '';
    const envType = (['cloud', 'pool', 'machine'].includes(envTypeRaw)
        ? envTypeRaw
        : undefined) as CloudAgentConfig['envType'];
    let modelParams: CloudAgentConfig['modelParams'];
    if (Array.isArray(ca.model_params)) {
        modelParams = ca.model_params
            .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
            .map((p) => ({ id: String(p.id ?? ''), value: String(p.value ?? '') }))
            .filter((p) => p.id);
    }
    result.cloudAgent = {
        enabled: ca.enabled === true,
        apiBase: String(ca.api_base || 'https://api.cursor.com/v1'),
        repoUrl: ca.repo_url != null ? String(ca.repo_url) : undefined,
        startingRef: ca.starting_ref != null ? String(ca.starting_ref) : undefined,
        envType,
        envName: ca.env_name != null ? String(ca.env_name) : undefined,
        model: String(ca.model || 'composer-2.5'),
        modelParams,
        readTimeoutSec: typeof ca.read_timeout === 'number' ? ca.read_timeout : 300,
        agentBusyRetries: typeof ca.agent_busy_retries === 'number' ? ca.agent_busy_retries : 15,
        agentBusyDelaySec: typeof ca.agent_busy_delay === 'number' ? ca.agent_busy_delay : 2,
        streamResumeRetries: typeof ca.stream_resume_retries === 'number' ? ca.stream_resume_retries : 5,
        sessionTtlSec: typeof ca.session_ttl_sec === 'number' ? ca.session_ttl_sec : 86400,
    };
}

/**
 * 浠?config.yaml 瑙ｆ瀽閰嶇疆锛堢函瑙ｆ瀽锛屼笉鍚幆澧冨彉閲忚鐩栵級
 */
function parseYamlConfig(defaults: AppConfig): { config: AppConfig; raw: Record<string, unknown> | null } {
    const result = { ...defaults, fingerprint: { ...defaults.fingerprint } };
    let raw: Record<string, unknown> | null = null;

    if (!existsSync('config.yaml')) return { config: result, raw };

    try {
        const content = readFileSync('config.yaml', 'utf-8');
        const yaml = parseYaml(content);
        raw = yaml;

        if (yaml.port) result.port = yaml.port;
        if (yaml.timeout) result.timeout = yaml.timeout;
        if (yaml.proxy) result.proxy = yaml.proxy;
        if (yaml.cursor_model) result.cursorModel = yaml.cursor_model;
        if (typeof yaml.max_auto_continue === 'number') result.maxAutoContinue = yaml.max_auto_continue;
        if (typeof yaml.max_history_messages === 'number') result.maxHistoryMessages = yaml.max_history_messages;
        if (typeof yaml.max_history_tokens === 'number') result.maxHistoryTokens = yaml.max_history_tokens;
        if (yaml.fingerprint) {
            if (yaml.fingerprint.user_agent) result.fingerprint.userAgent = yaml.fingerprint.user_agent;
        }
        if (yaml.vision) {
            result.vision = {
                enabled: yaml.vision.enabled !== false,
                mode: yaml.vision.mode || 'ocr',
                baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                apiKey: yaml.vision.api_key || '',
                model: yaml.vision.model || 'gpt-4o-mini',
                proxy: yaml.vision.proxy || undefined,
            };
        }
        // 鈽?鑷畾涔夌郴缁熸彁绀鸿瘝
        if (yaml.system_prompt) result.systemPrompt = String(yaml.system_prompt);
        // 鈽?Cursor Cookie锛堢敤浜庨€氳繃 Vercel 瀹夊叏楠岃瘉锛?
        if (yaml.cookie) result.cookie = String(yaml.cookie);
        // 鈽?Cursor Session Token锛堝悎骞朵负 WorkosCursorSessionToken Cookie锛?
        if (yaml.cursor_session_token) result.sessionToken = String(yaml.cursor_session_token);
        if (yaml.cursor_api_key) result.apiKey = String(yaml.cursor_api_key);
        parseCloudAgentYaml(yaml, result);
        // 鈽?Stealth 浠ｇ悊
        if (yaml.stealth_proxy) result.stealthProxy = String(yaml.stealth_proxy);
        // 鈽?API 閴存潈 token
        if (yaml.auth_tokens) {
            result.authTokens = Array.isArray(yaml.auth_tokens)
                ? yaml.auth_tokens.map(String)
                : String(yaml.auth_tokens).split(',').map((s: string) => s.trim()).filter(Boolean);
        }
        // 鈽?鍘嗗彶鍘嬬缉閰嶇疆
        if (yaml.compression !== undefined) {
            const c = yaml.compression;
            result.compression = {
                enabled: c.enabled !== false, // 榛樿鍚敤
                level: [1, 2, 3].includes(c.level) ? c.level : 1,
                keepRecent: typeof c.keep_recent === 'number' ? c.keep_recent : 10,
                earlyMsgMaxChars: typeof c.early_msg_max_chars === 'number' ? c.early_msg_max_chars : 4000,
            };
        }
        // 鈽?Thinking 寮€鍏筹紙鏈€楂樹紭鍏堢骇锛?
        if (yaml.thinking !== undefined) {
            result.thinking = {
                enabled: yaml.thinking.enabled !== false, // 榛樿鍚敤
            };
        }
        // 鈽?鏃ュ織鏂囦欢鎸佷箙鍖?
        if (yaml.logging !== undefined) {
            const persistModes = ['compact', 'full', 'summary'];
            result.logging = {
                file_enabled: yaml.logging.file_enabled === true, // 榛樿鍏抽棴
                dir: yaml.logging.dir || './logs',
                max_days: typeof yaml.logging.max_days === 'number' ? yaml.logging.max_days : 7,
                persist_mode: persistModes.includes(yaml.logging.persist_mode) ? yaml.logging.persist_mode : 'summary',
                db_enabled: yaml.logging.db_enabled === true,
                db_path: yaml.logging.db_path || './logs/cursor2api.db',
            };
        }
        // 鈽?宸ュ叿澶勭悊閰嶇疆
        if (yaml.tools !== undefined) {
            const t = yaml.tools;
            const validModes = ['compact', 'full', 'names_only'];
            result.tools = {
                schemaMode: validModes.includes(t.schema_mode) ? t.schema_mode : 'full',
                descriptionMaxLength: typeof t.description_max_length === 'number' ? t.description_max_length : 0,
                includeOnly: Array.isArray(t.include_only) ? t.include_only.map(String) : undefined,
                exclude: Array.isArray(t.exclude) ? t.exclude.map(String) : undefined,
                passthrough: t.passthrough === true,
                disabled: t.disabled === true,
                adaptiveBudget: t.adaptive_budget === true,    // 榛樿鍏抽棴
                smartTruncation: t.smart_truncation === true,   // 榛樿鍏抽棴
            };
        }
        // 鈽?鍝嶅簲鍐呭娓呮礂寮€鍏筹紙榛樿鍏抽棴锛?
        if (yaml.sanitize_response !== undefined) {
            result.sanitizeEnabled = yaml.sanitize_response === true;
        }
        // 鈽?鑷畾涔夋嫆缁濇娴嬭鍒?
        if (Array.isArray(yaml.refusal_patterns)) {
            result.refusalPatterns = yaml.refusal_patterns.map(String).filter(Boolean);
        }
        // 鈽?涓婁笅鏂囧帇鍔涜啫鑳€绯绘暟
        if (typeof yaml.context_pressure === 'number') {
            result.contextPressure = yaml.context_pressure;
        }
    } catch (e) {
        console.warn('[Config] Failed to read config.yaml:', e);
    }

    return { config: result, raw };
}

/**
 * 搴旂敤鐜鍙橀噺瑕嗙洊锛堢幆澧冨彉閲忎紭鍏堢骇鏈€楂橈紝涓嶅彈鐑噸杞藉奖鍝嶏級
 */
function applyEnvOverrides(cfg: AppConfig): void {
    if (process.env.PORT) cfg.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) cfg.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) cfg.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) cfg.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.MAX_AUTO_CONTINUE !== undefined) cfg.maxAutoContinue = parseInt(process.env.MAX_AUTO_CONTINUE);
    if (process.env.MAX_HISTORY_MESSAGES !== undefined) cfg.maxHistoryMessages = parseInt(process.env.MAX_HISTORY_MESSAGES);
    if (process.env.MAX_HISTORY_TOKENS !== undefined) cfg.maxHistoryTokens = parseInt(process.env.MAX_HISTORY_TOKENS);
    if (process.env.AUTH_TOKEN) {
        cfg.authTokens = process.env.AUTH_TOKEN.split(',').map(s => s.trim()).filter(Boolean);
    }
    // 鍘嬬缉鐜鍙橀噺瑕嗙洊
    if (process.env.COMPRESSION_ENABLED !== undefined) {
        if (!cfg.compression) cfg.compression = { enabled: false, level: 1, keepRecent: 10, earlyMsgMaxChars: 4000 };
        cfg.compression.enabled = process.env.COMPRESSION_ENABLED !== 'false' && process.env.COMPRESSION_ENABLED !== '0';
    }
    if (process.env.COMPRESSION_LEVEL) {
        if (!cfg.compression) cfg.compression = { enabled: false, level: 1, keepRecent: 10, earlyMsgMaxChars: 4000 };
        const lvl = parseInt(process.env.COMPRESSION_LEVEL);
        if (lvl >= 1 && lvl <= 3) cfg.compression.level = lvl as 1 | 2 | 3;
    }
    // Thinking 鐜鍙橀噺瑕嗙洊锛堟渶楂樹紭鍏堢骇锛?
    if (process.env.THINKING_ENABLED !== undefined) {
        cfg.thinking = {
            enabled: process.env.THINKING_ENABLED !== 'false' && process.env.THINKING_ENABLED !== '0',
        };
    }
    // Logging 鐜鍙橀噺瑕嗙洊
    if (process.env.LOG_FILE_ENABLED !== undefined) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.file_enabled = process.env.LOG_FILE_ENABLED === 'true' || process.env.LOG_FILE_ENABLED === '1';
    }
    if (process.env.LOG_DIR) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.dir = process.env.LOG_DIR;
    }
    if (process.env.LOG_PERSIST_MODE) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.persist_mode = process.env.LOG_PERSIST_MODE === 'full'
            ? 'full'
            : process.env.LOG_PERSIST_MODE === 'summary'
                ? 'summary'
                : 'compact';
    }
    if (process.env.LOG_DB_ENABLED !== undefined) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.db_enabled = process.env.LOG_DB_ENABLED === 'true' || process.env.LOG_DB_ENABLED === '1';
    }
    if (process.env.LOG_DB_PATH) {
        if (!cfg.logging) cfg.logging = { file_enabled: false, dir: './logs', max_days: 7, persist_mode: 'summary', db_enabled: false, db_path: './logs/cursor2api.db' };
        cfg.logging.db_path = process.env.LOG_DB_PATH;
    }
    // 宸ュ叿閫忎紶妯″紡鐜鍙橀噺瑕嗙洊
    if (process.env.TOOLS_PASSTHROUGH !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.passthrough = process.env.TOOLS_PASSTHROUGH === 'true' || process.env.TOOLS_PASSTHROUGH === '1';
    }
    // 宸ュ叿绂佺敤妯″紡鐜鍙橀噺瑕嗙洊
    if (process.env.TOOLS_DISABLED !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.disabled = process.env.TOOLS_DISABLED === 'true' || process.env.TOOLS_DISABLED === '1';
    }
    // 鑷€傚簲鍘嗗彶棰勭畻鐜鍙橀噺瑕嗙洊
    if (process.env.TOOLS_ADAPTIVE_BUDGET !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.adaptiveBudget = process.env.TOOLS_ADAPTIVE_BUDGET !== 'false' && process.env.TOOLS_ADAPTIVE_BUDGET !== '0';
    }
    // 鏅鸿兘鎴柇鐜鍙橀噺瑕嗙洊
    if (process.env.TOOLS_SMART_TRUNCATION !== undefined) {
        if (!cfg.tools) cfg.tools = { schemaMode: 'full', descriptionMaxLength: 0 };
        cfg.tools.smartTruncation = process.env.TOOLS_SMART_TRUNCATION !== 'false' && process.env.TOOLS_SMART_TRUNCATION !== '0';
    }

    // 鍝嶅簲鍐呭娓呮礂鐜鍙橀噺瑕嗙洊
    if (process.env.SANITIZE_RESPONSE !== undefined) {
        cfg.sanitizeEnabled = process.env.SANITIZE_RESPONSE === 'true' || process.env.SANITIZE_RESPONSE === '1';
    }
    // 涓婁笅鏂囧帇鍔涜啫鑳€绯绘暟鐜鍙橀噺瑕嗙洊
    if (process.env.CONTEXT_PRESSURE !== undefined) {
        cfg.contextPressure = parseFloat(process.env.CONTEXT_PRESSURE);
    }

    // 鑷畾涔夌郴缁熸彁绀鸿瘝鐜鍙橀噺瑕嗙洊
    if (process.env.SYSTEM_PROMPT) cfg.systemPrompt = process.env.SYSTEM_PROMPT;
    // Cookie 鐜鍙橀噺瑕嗙洊
    if (process.env.CURSOR_COOKIE) cfg.cookie = process.env.CURSOR_COOKIE;
    if (process.env.CURSOR_API_KEY) cfg.apiKey = process.env.CURSOR_API_KEY;
    if (process.env.CLOUD_AGENT_ENABLED !== undefined) {
        ensureCloudAgent(cfg).enabled =
            process.env.CLOUD_AGENT_ENABLED === 'true' || process.env.CLOUD_AGENT_ENABLED === '1';
    }
    if (process.env.CLOUD_AGENT_REPO_URL) {
        ensureCloudAgent(cfg).repoUrl = process.env.CLOUD_AGENT_REPO_URL;
    }
    if (process.env.CLOUD_AGENT_STARTING_REF) {
        ensureCloudAgent(cfg).startingRef = process.env.CLOUD_AGENT_STARTING_REF;
    }
    if (process.env.CLOUD_AGENT_ENV_TYPE) {
        ensureCloudAgent(cfg).envType = process.env.CLOUD_AGENT_ENV_TYPE as CloudAgentConfig['envType'];
    }
    if (process.env.CLOUD_AGENT_ENV_NAME) {
        ensureCloudAgent(cfg).envName = process.env.CLOUD_AGENT_ENV_NAME;
    }
    if (process.env.CLOUD_AGENT_MODEL) {
        ensureCloudAgent(cfg).model = process.env.CLOUD_AGENT_MODEL;
    }
    if (process.env.CLOUD_AGENT_API_BASE) {
        ensureCloudAgent(cfg).apiBase = process.env.CLOUD_AGENT_API_BASE;
    }
    // Session Token锛欳URSOR_SESSION_TOKEN锛屾垨璇啓鍦?.env 閲岀殑 WorkosCursorSessionToken=...
    const sessionFromEnv =
        process.env.CURSOR_SESSION_TOKEN || process.env.WorkosCursorSessionToken;
    if (sessionFromEnv) cfg.sessionToken = sessionFromEnv;
    // Stealth 浠ｇ悊鐜鍙橀噺瑕嗙洊
    if (process.env.STEALTH_PROXY) cfg.stealthProxy = process.env.STEALTH_PROXY;
    // 浠?base64 FP 鐜鍙橀噺瑙ｆ瀽鎸囩汗
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) cfg.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 瑙ｆ瀽 FP 鐜鍙橀噺澶辫触:', e);
        }
    }

    // 灏?sessionToken 鍚堝苟杩?cookie锛圵orkosCursorSessionToken=...锛?
    resolveCursorCookie(cfg);
}

/**
 * 鏋勫缓榛樿閰嶇疆
 */
function defaultConfig(): AppConfig {
    return {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        maxAutoContinue: 0,
        maxHistoryMessages: -1,
        maxHistoryTokens: 150000,
        sanitizeEnabled: false,  // 榛樿鍏抽棴鍝嶅簲鍐呭娓呮礂
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        },
    };
}

/**
 * 妫€娴嬮厤缃彉鏇村苟杩斿洖鍙樻洿鎻忚堪鍒楄〃
 */
function detectChanges(oldCfg: AppConfig, newCfg: AppConfig): string[] {
    const changes: string[] = [];

    if (oldCfg.port !== newCfg.port) changes.push(`port: ${oldCfg.port} 鈫?${newCfg.port}`);
    if (oldCfg.timeout !== newCfg.timeout) changes.push(`timeout: ${oldCfg.timeout} 鈫?${newCfg.timeout}`);
    if (oldCfg.proxy !== newCfg.proxy) changes.push(`proxy: ${oldCfg.proxy || '(none)'} 鈫?${newCfg.proxy || '(none)'}`);
    if (oldCfg.cursorModel !== newCfg.cursorModel) changes.push(`cursor_model: ${oldCfg.cursorModel} 鈫?${newCfg.cursorModel}`);
    if (oldCfg.maxAutoContinue !== newCfg.maxAutoContinue) changes.push(`max_auto_continue: ${oldCfg.maxAutoContinue} 鈫?${newCfg.maxAutoContinue}`);
    if (oldCfg.maxHistoryMessages !== newCfg.maxHistoryMessages) changes.push(`max_history_messages: ${oldCfg.maxHistoryMessages} 鈫?${newCfg.maxHistoryMessages}`);
    if (oldCfg.maxHistoryTokens !== newCfg.maxHistoryTokens) changes.push(`max_history_tokens: ${oldCfg.maxHistoryTokens} 鈫?${newCfg.maxHistoryTokens}`);

    // auth_tokens
    const oldTokens = (oldCfg.authTokens || []).join(',');
    const newTokens = (newCfg.authTokens || []).join(',');
    if (oldTokens !== newTokens) changes.push(`auth_tokens: ${oldCfg.authTokens?.length || 0} 鈫?${newCfg.authTokens?.length || 0} token(s)`);

    // thinking
    if (JSON.stringify(oldCfg.thinking) !== JSON.stringify(newCfg.thinking)) changes.push(`thinking: ${JSON.stringify(oldCfg.thinking)} 鈫?${JSON.stringify(newCfg.thinking)}`);

    // vision
    if (JSON.stringify(oldCfg.vision) !== JSON.stringify(newCfg.vision)) changes.push('vision: (changed)');

    // compression
    if (JSON.stringify(oldCfg.compression) !== JSON.stringify(newCfg.compression)) changes.push('compression: (changed)');

    // logging
    if (JSON.stringify(oldCfg.logging) !== JSON.stringify(newCfg.logging)) changes.push('logging: (changed)');

    // tools
    if (JSON.stringify(oldCfg.tools) !== JSON.stringify(newCfg.tools)) changes.push('tools: (changed)');

    // refusalPatterns
    // sanitize_response
    if (oldCfg.sanitizeEnabled !== newCfg.sanitizeEnabled) changes.push(`sanitize_response: ${oldCfg.sanitizeEnabled} 鈫?${newCfg.sanitizeEnabled}`);

    if (JSON.stringify(oldCfg.refusalPatterns) !== JSON.stringify(newCfg.refusalPatterns)) changes.push(`refusal_patterns: ${oldCfg.refusalPatterns?.length || 0} 鈫?${newCfg.refusalPatterns?.length || 0} rule(s)`);

    // cookie / sessionToken
    if (oldCfg.sessionToken !== newCfg.sessionToken) {
        changes.push(`cursor_session_token: ${oldCfg.sessionToken ? '(set)' : '(none)'} 鈫?${newCfg.sessionToken ? '(set)' : '(none)'}`);
    }
    if (oldCfg.cookie !== newCfg.cookie) changes.push(`cookie: ${oldCfg.cookie ? '(set)' : '(none)'} 鈫?${newCfg.cookie ? '(set)' : '(none)'}`);
    // stealth_proxy
    if (oldCfg.stealthProxy !== newCfg.stealthProxy) changes.push(`stealth_proxy: ${oldCfg.stealthProxy || '(none)'} 鈫?${newCfg.stealthProxy || '(none)'}`);
    // fingerprint
    if (oldCfg.fingerprint.userAgent !== newCfg.fingerprint.userAgent) changes.push('fingerprint: (changed)');

    return changes;
}

/**
 * 鑾峰彇褰撳墠閰嶇疆锛堟墍鏈夋ā鍧楃粺涓€閫氳繃姝ゅ嚱鏁拌幏鍙栨渶鏂伴厤缃級
 */
export function getConfig(): AppConfig {
    if (config) return config;

    // 棣栨鍔犺浇
    const defaults = defaultConfig();
    const { config: parsed } = parseYamlConfig(defaults);
    applyEnvOverrides(parsed);
    config = parsed;
    return config;
}

/**
 * 鍒濆鍖?config.yaml 鏂囦欢鐩戝惉锛屽疄鐜扮儹閲嶈浇
 *
 * 绔彛鍙樻洿浠呰褰曡鍛婏紙闇€閲嶅惎鐢熸晥锛夛紝鍏朵粬瀛楁涓嬩竴娆¤姹傚嵆鐢熸晥銆?
 * 鐜鍙橀噺瑕嗙洊濮嬬粓淇濇寔鏈€楂樹紭鍏堢骇锛屼笉鍙楃儹閲嶈浇褰卞搷銆?
 */
export function initConfigWatcher(): void {
    if (watcher) return; // 閬垮厤閲嶅鍒濆鍖?
    if (!existsSync('config.yaml')) {
        console.log('[Config] config.yaml 不存在，跳过热重载监听');
        return;
    }

    const DEBOUNCE_MS = 500;

    watcher = watch('config.yaml', (eventType) => {
        if (eventType !== 'change') return;

        // 闃叉姈锛氬娆″揩閫熷啓鍏ュ彧瑙﹀彂涓€娆￠噸杞?
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            try {
                if (!existsSync('config.yaml')) {
                    console.warn('[Config] config.yaml 已被删除，保持当前配置');
                    return;
                }

                const oldConfig = config;
                const oldPort = oldConfig.port;

                // 閲嶆柊瑙ｆ瀽 YAML + 鐜鍙橀噺瑕嗙洊
                const defaults = defaultConfig();
                const { config: newConfig } = parseYamlConfig(defaults);
                applyEnvOverrides(newConfig);

                // 妫€娴嬪彉鏇?
                const changes = detectChanges(oldConfig, newConfig);
                if (changes.length === 0) return; // 鏃犲疄璐ㄥ彉鏇?

                // 鈽?绔彛鍙樻洿鐗规畩澶勭悊锛氫粎璀﹀憡锛屼笉鐢熸晥
                if (newConfig.port !== oldPort) {
                    console.warn(`[Config] 检测到 port 变更 (${oldPort} -> ${newConfig.port})，端口变更需要重启服务才会生效`);
                    newConfig.port = oldPort; // 淇濇寔鍘熺鍙?
                }

                // 鏇挎崲鍏ㄥ眬閰嶇疆瀵硅薄锛堜笅涓€娆?getConfig() 璋冪敤鍗宠繑鍥炴柊閰嶇疆锛?
                config = newConfig;

                console.log(`[Config] config.yaml 已热重载，${changes.length} 项变更`);
                changes.forEach(c => console.log(`  鈹斺攢 ${c}`));

                // 瑙﹀彂鍥炶皟
                for (const cb of reloadCallbacks) {
                    try {
                        cb(newConfig, changes);
                    } catch (e) {
                        console.warn('[Config] Config reload callback failed:', e);
                    }
                }
            } catch (e) {
                console.error('[Config] Hot reload failed, keeping current config:', e);
            }
        }, DEBOUNCE_MS);
    });

    // 寮傚父澶勭悊锛歸atcher 鎸傛帀鍚庡皾璇曢噸寤?
    watcher.on('error', (err) => {
        console.error('[Config] File watcher error:', err);
        watcher = null;
        // 2 绉掑悗灏濊瘯閲嶆柊寤虹珛鐩戝惉
        setTimeout(() => {
            console.log('[Config] Re-establishing config.yaml watcher...');
            initConfigWatcher();
        }, 2000);
    });

    console.log('[Config] Watching config.yaml for changes (hot reload enabled)');
}

/**
 * 鍋滄鏂囦欢鐩戝惉锛堢敤浜庝紭闆呭叧闂級
 */
export function stopConfigWatcher(): void {
    if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
    }
    if (watcher) {
        watcher.close();
        watcher = null;
    }
}
