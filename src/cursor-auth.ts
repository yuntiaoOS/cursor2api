/**
 * cursor-auth.ts - Cursor 璇锋眰 Cookie / Session Token 缁勮
 *
 * 灏?CURSOR_SESSION_TOKEN锛堟垨 config.yaml 鐨?cursor_session_token锛? * 鍚堝苟涓?WorkosCursorSessionToken Cookie锛屽彲涓庡畬鏁?CURSOR_COOKIE 骞跺瓨銆? */

import type { AppConfig } from './types.js';
import { fetchVcrcsValue } from './vcrcs-fetcher.js';

const CURSOR_API_KEY_INFO_URL = 'https://api.cursor.com/v0/me';

/** Cursor 鐧诲綍浼氳瘽 Cookie 鍚?*/
export const WORKOS_SESSION_COOKIE = 'WorkosCursorSessionToken';

/** Vercel Bot Protection Cookie 鍚?*/
export const VCRCS_COOKIE = '_vcrcs';

let vcrcsRefreshPromise: Promise<void> | null = null;

/** crsr_ 鍓嶇紑涓?Cursor API Key锛屼笉鏄祻瑙堝櫒 Cookie 閲岀殑 WorkosCursorSessionToken */
export function isCrsrApiKey(token: string): boolean {
    return token.trim().toLowerCase().startsWith('crsr_');
}

/** 瑙ｆ瀽 _vcrcs 杩囨湡鏃堕棿锛堟牸寮?1.<issued>.<ttl>.鈥︼級 */
export function getVcrcsExpiry(cookie?: string): Date | null {
    if (!cookie) return null;
    const m = cookie.match(/_vcrcs=1\.(\d+)\.(\d+)\./);
    if (!m) return null;
    const issued = parseInt(m[1], 10);
    const ttl = parseInt(m[2], 10);
    if (!Number.isFinite(issued) || !Number.isFinite(ttl)) return null;
    return new Date((issued + ttl) * 1000);
}

/** 鏄惁涓轰粎鍊肩殑 _vcrcs锛堜粠 DevTools 鍙鍒朵簡 Value 鍒楋紝鏈甫 `_vcrcs=` 鍓嶇紑锛?*/
export function isBareVcrcsValue(value: string): boolean {
    const t = value.trim();
    if (!t || t.includes(';')) return false;
    if (t.toLowerCase().startsWith(`${VCRCS_COOKIE}=`)) return false;
    // 鍏稿瀷褰㈡€? 1.<ts>.<ttl>.<base64>.<hex>
    return /^1\.\d+\.\d+\./.test(t);
}

/**
 * 瑙勮寖鍖?CURSOR_COOKIE 杈撳叆锛氭敮鎸佸畬鏁?Cookie 涓诧紝鎴栦粎绮樿创 _vcrcs 鐨勫€? */
export function normalizeCursorCookieInput(raw?: string): string | undefined {
    const t = raw?.trim();
    if (!t) return undefined;
    if (hasVcrcsCookie(t)) return t;
    if (isBareVcrcsValue(t)) return `${VCRCS_COOKIE}=${t}`;
    return t;
}

/** Cookie 鏄惁鍖呭惈 _vcrcs锛堥€氳繃 Vercel 鏍￠獙鎵€蹇呴渶锛?*/
export function hasVcrcsCookie(cookie?: string): boolean {
    if (!cookie?.trim()) return false;
    return cookie.split(';').some((p) => {
        const i = p.indexOf('=');
        if (i <= 0) return false;
        return p.slice(0, i).trim().toLowerCase() === VCRCS_COOKIE;
    });
}

/**
 * 灏?session token 涓庡凡鏈?Cookie 鍚堝苟涓烘渶缁?Cookie 澶? */
export function buildCursorCookie(options: {
    cookie?: string;
    sessionToken?: string;
}): string | undefined {
    const rawCookie = options.cookie?.trim();
    const rawToken = options.sessionToken?.trim();

    if (!rawToken && !rawCookie) return undefined;
    if (!rawToken) return rawCookie;

    const tokenValue = normalizeSessionToken(rawToken);

    // crsr_ 鏄?API Key锛屽啓鍏?WorkosCursorSessionToken 浼氬鑷?403
    if (isCrsrApiKey(tokenValue)) {
        return normalizeCursorCookieInput(rawCookie);
    }

    const sessionPair = `${WORKOS_SESSION_COOKIE}=${tokenValue}`;

    if (!rawCookie) return sessionPair;
    return mergeCookiePair(rawCookie, WORKOS_SESSION_COOKIE, tokenValue);
}

/**
 * 瑙ｆ瀽鐢ㄦ埛杈撳叆锛氭敮鎸佽８ token銆乧rsr_ 鍓嶇紑銆佹垨瀹屾暣鐨?name=value
 */
export function normalizeSessionToken(token: string): string {
    const trimmed = token.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) return trimmed;

    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (name.toLowerCase() === WORKOS_SESSION_COOKIE.toLowerCase()) {
        return value;
    }
    return trimmed;
}

/** 鏇挎崲鎴栬拷鍔犳寚瀹?Cookie 閿?*/
export function mergeCookiePair(cookie: string, name: string, value: string): string {
    const lowerName = name.toLowerCase();
    const parts = cookie
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
        .filter((p) => {
            const i = p.indexOf('=');
            if (i <= 0) return true;
            return p.slice(0, i).trim().toLowerCase() !== lowerName;
        });
    parts.push(`${name}=${value}`);
    return parts.join('; ');
}

/**
 * 鏍规嵁 cookie + sessionToken 瑙ｆ瀽鏈€缁堝彂寰€ Cursor 鐨?Cookie
 */
export function resolveCursorCookie(cfg: { cookie?: string; sessionToken?: string }): void {
    const cookie = normalizeCursorCookieInput(cfg.cookie);
    cfg.cookie = buildCursorCookie({
        cookie,
        sessionToken: cfg.sessionToken,
    });
}

/** 鍚姩鏃舵墦鍗拌璇佺姸鎬侊紙涓嶈緭鍑?token 鏄庢枃锛?*/
export function logCursorAuthStatus(cfg: AppConfig): void {
    if (cfg.cloudAgent?.enabled && cfg.apiKey?.trim()) {
        const ca = cfg.cloudAgent;
        const env = ca.envType && ca.envName ? `${ca.envType}/${ca.envName}` : ca.envType || 'cloud';
        console.log('[Cursor] Cloud Agent 模式（api.cursor.com/v1/agents，Basic 鉴权）');
        console.log(`[Cursor]   model=${ca.model} env=${env} repo=${ca.repoUrl ?? '(none)'} ref=${ca.startingRef ?? 'default'}`);
        return;
    }
    if (cfg.apiKey?.trim()) {
        console.log('[Cursor] CURSOR_API_KEY 已配置（Bearer 鉴权，独占模式）');
        return;
    }

    const hasSession =
        !!cfg.sessionToken?.trim() ||
        (cfg.cookie?.includes(`${WORKOS_SESSION_COOKIE}=`) ?? false);
    const hasVcrcs = hasVcrcsCookie(cfg.cookie);

    if (process.env.WorkosCursorSessionToken && !process.env.CURSOR_SESSION_TOKEN) {
        console.log(
            '[Cursor] 已从环境变量 WorkosCursorSessionToken 读取登录态（建议改用 CURSOR_SESSION_TOKEN 或写入 CURSOR_COOKIE）',
        );
    }

    if (cfg.sessionToken?.trim()) {
        if (isCrsrApiKey(cfg.sessionToken)) {
            console.warn(
                '[Cursor] ⚠️  CURSOR_SESSION_TOKEN 为 crsr_（API Key），不会写入 WorkosCursorSessionToken Cookie。',
            );
            console.warn(
                '[Cursor]    For /api/chat, use the browser cookie: DevTools -> Application -> WorkosCursorSessionToken',
            );
        } else {
            console.log('[Cursor] CURSOR_SESSION_TOKEN → WorkosCursorSessionToken（已合并）');
        }
    } else if (hasSession) {
        console.log('[Cursor] WorkosCursorSessionToken is configured');
    }

    if (hasVcrcs) {
        const exp = getVcrcsExpiry(cfg.cookie);
        if (exp && exp.getTime() < Date.now()) {
            console.warn(
                `[Cursor] _vcrcs may be expired (around ${exp.toLocaleString()}); please refresh CURSOR_COOKIE`,
            );
        } else {
            console.log('[Cursor] _vcrcs 已就绪（来自 CURSOR_COOKIE / 自动获取）');
        }
    } else if (!cfg.stealthProxy) {
        console.warn(
            '[Cursor] Missing _vcrcs for Vercel verification. Session token alone will still 403; refresh _vcrcs or use stealth.',
        );
    }

    if (!cfg.stealthProxy && cfg.cursorModel !== DOCS_API_MODEL) {
        console.warn(
            `[Cursor] Docs API recommends ${DOCS_API_MODEL}; current model is ${cfg.cursorModel}, and an unsupported model may also 403`,
        );
    }
}

/**
 * 鍚姩鍓嶇‘淇?Cookie 瀹屾暣锛氱己 _vcrcs 鏃惰嚜鍔ㄧ敤娴忚鍣ㄨ幏鍙栵紙鐩磋繛妯″紡锛? */
export async function ensureCursorAuth(cfg: AppConfig): Promise<void> {
    if (cfg.stealthProxy) return;
    if (cfg.apiKey?.trim()) {
        await validateCursorApiKey(cfg.apiKey);
        return;
    }
    if (hasVcrcsCookie(cfg.cookie)) return;

    const autoFetch =
        process.env.AUTO_FETCH_VCRCS !== 'false' && process.env.AUTO_FETCH_VCRCS !== '0';
    if (!autoFetch) {
        console.warn(
            '[Cursor] ⚠️  Cookie 缺少 _vcrcs，请求可能返回 403。' +
                '请配置 CURSOR_COOKIE、启用 stealth，或保持 AUTO_FETCH_VCRCS 开启',
        );
        return;
    }

    if (vcrcsRefreshPromise) {
        await vcrcsRefreshPromise;
        return;
    }

    vcrcsRefreshPromise = (async () => {
        console.log('[Cursor] 姝ｅ湪鑷姩鑾峰彇 _vcrcs锛圴ercel 楠岃瘉锛岄娆＄害 30鈥?20 绉掞級...');
        try {
            const value = await fetchVcrcsValue();
            cfg.cookie = mergeCookiePair(cfg.cookie || '', VCRCS_COOKIE, value);
            console.log('[Cursor] 鉁?_vcrcs 宸茶幏鍙栧苟鍚堝苟鍒?Cookie');
        } catch (e) {
            console.error(
                '[Cursor] 鉂?鑷姩鑾峰彇 _vcrcs 澶辫触:',
                e instanceof Error ? e.message : e,
            );
            console.error(
                '[Cursor]    鍙敼鐢? npm run dev:stealth  鎴栨墜鍔ㄩ厤缃惈 _vcrcs 鐨?CURSOR_COOKIE',
            );
        } finally {
            vcrcsRefreshPromise = null;
        }
    })();

    await vcrcsRefreshPromise;
}

/** 鏂囨。椤?API 褰撳墠鍙敤妯″瀷锛堣 README锛?*/
export const DOCS_API_MODEL = 'google/gemini-3-flash';

export function log403Diagnostics(cfg: AppConfig): void {
    const hints: string[] = [];
    if (cfg.apiKey?.trim()) {
        hints.push('CURSOR_API_KEY 已通过 /v0/me 校验，但 cursor.com/api/chat 可能不接受 Dashboard API Key；如仍 403，请改用 Cookie/stealth');
    }
    if (cfg.cursorModel !== DOCS_API_MODEL) {
        hints.push(
            `妯″瀷 "${cfg.cursorModel}" 鍙兘涓嶈鏂囨。椤?API 鎺ュ彈锛岃鏀?CURSOR_MODEL=${DOCS_API_MODEL}`,
        );
    }
    if (cfg.sessionToken && isCrsrApiKey(cfg.sessionToken)) {
        hints.push(
            'CURSOR_SESSION_TOKEN 涓?crsr_ API Key锛屼笉鑳藉綋 Cookie锛涜澶嶅埗 WorkosCursorSessionToken 鎴栦粎淇濈暀鏈夋晥 _vcrcs',
        );
    }
    if (hasVcrcsCookie(cfg.cookie)) {
        const exp = getVcrcsExpiry(cfg.cookie);
        if (exp && exp.getTime() < Date.now()) {
            hints.push(`_vcrcs 宸茶繃鏈燂紙绾?${exp.toLocaleString()}锛夛紝璇烽噸鏂板鍒?CURSOR_COOKIE`);
        } else {
            hints.push('_vcrcs 已配置但仍 403：请更新 _vcrcs，或从浏览器复制 WorkosCursorSessionToken（非 crsr_）');
        }
    } else {
        hints.push('缂哄皯 _vcrcs锛岃鏇存柊 CURSOR_COOKIE 鎴?npm run fetch:vcrcs:headed');
    }
    console.error('[Cursor] 403 鎺掓煡寤鸿:');
    for (const h of hints) console.error(`[Cursor]   路 ${h}`);
}

export async function validateCursorApiKey(apiKey?: string): Promise<void> {
    const key = apiKey?.trim();
    if (!key) return;

    const resp = await fetch(CURSOR_API_KEY_INFO_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
    });

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Cursor API Key 校验失败: HTTP ${resp.status}${body ? ` - ${body}` : ''}`);
    }

    const info = await resp.json().catch(() => null) as { apiKeyName?: string; userEmail?: string } | null;
    const name = info?.apiKeyName ? ` ${info.apiKeyName}` : '';
    const email = info?.userEmail ? ` (${info.userEmail})` : '';
    console.log(`[Cursor] CURSOR_API_KEY 校验通过${name}${email}`);
}

/** 403 鍚庯細浠呭湪娌℃湁 _vcrcs 鏃舵墠灏濊瘯娴忚鍣ㄩ噸鏂拌幏鍙?*/
export async function refreshVcrcsOnDenied(cfg: AppConfig): Promise<boolean> {
    if (cfg.stealthProxy) return false;

    const autoFetch =
        process.env.AUTO_FETCH_VCRCS !== 'false' && process.env.AUTO_FETCH_VCRCS !== '0';
    if (!autoFetch) {
        log403Diagnostics(cfg);
        return false;
    }

    if (vcrcsRefreshPromise) {
        await vcrcsRefreshPromise;
        return hasVcrcsCookie(cfg.cookie);
    }

    try {
        const reason = hasVcrcsCookie(cfg.cookie) ? '刷新已有 _vcrcs' : '补齐缺失 _vcrcs';
        console.log(`[Cursor] 403 Access denied，尝试${reason}...`);
        const value = await fetchVcrcsValue();
        cfg.cookie = mergeCookiePair(cfg.cookie || '', VCRCS_COOKIE, value);
        console.log('[Cursor] 403 后已刷新 _vcrcs，将立即重试请求');
        return true;
    } catch {
        log403Diagnostics(cfg);
        return false;
    }
}
