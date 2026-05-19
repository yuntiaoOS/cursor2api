/**
 * 获取 Cursor _vcrcs Cookie（供 cursor2api 启动时调用）
 * 成功时仅向 stdout 输出 token 值（单行），日志走 stderr
 *
 * 逻辑与 stealth-proxy/index.js challenge 路径对齐（含模拟行为与一次 reload 重试）
 */
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: join(projectRoot, '.env') });

const CHALLENGE_URL = process.env.CHALLENGE_URL || 'https://cursor.com/cn/docs';
// 单次等待时长（毫秒），可与 stealth-proxy 共用 CHALLENGE_WAIT
const CHALLENGE_WAIT = parseInt(process.env.CHALLENGE_WAIT || '90000', 10);
// 有头模式：npm run fetch:vcrcs:headed  或  PowerShell: $env:HEADLESS='false'; npm run fetch:vcrcs
const HEADLESS =
    !process.argv.includes('--headed') && process.env.HEADLESS !== 'false';

function findSystemChrome() {
    const paths = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of paths) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function log(...args) {
    console.error('[fetch-vcrcs]', ...args);
}

/** 从 .env 的 CURSOR_SESSION_TOKEN / WorkosCursorSessionToken 解析登录 Cookie 值 */
function getSessionTokenValue() {
    const raw =
        process.env.CURSOR_SESSION_TOKEN?.trim() ||
        process.env.WorkosCursorSessionToken?.trim() ||
        '';
    if (!raw) return null;
    const eq = raw.indexOf('=');
    if (eq > 0 && raw.slice(0, eq).toLowerCase() === 'workoscursorsessiontoken') {
        return raw.slice(eq + 1).trim();
    }
    return raw;
}

async function injectSessionCookie(context) {
    const value = getSessionTokenValue();
    if (!value || value.toLowerCase().startsWith('crsr_')) return false;
    await context.addCookies([
        {
            name: 'WorkosCursorSessionToken',
            value,
            domain: '.cursor.com',
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'Lax',
        },
    ]);
    log('已从 .env 注入 WorkosCursorSessionToken（已登录态拉取 _vcrcs）');
    return true;
}

/** 模拟人类行为：与 stealth-proxy/index.js 一致 */
async function simulateHumanBehavior(page) {
    try {
        await new Promise((r) => setTimeout(r, 500 + Math.random() * 1000));
        const points = Array.from({ length: 5 }, () => ({
            x: 100 + Math.random() * 600,
            y: 100 + Math.random() * 400,
        }));
        for (const p of points) {
            await page.mouse.move(p.x, p.y, { steps: 5 + Math.floor(Math.random() * 10) });
            await new Promise((r) => setTimeout(r, 100 + Math.random() * 300));
        }
        await page.mouse.wheel(0, 100 + Math.random() * 200);
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 500));
        await page.mouse.wheel(0, -(50 + Math.random() * 100));
        await page.mouse.click(300 + Math.random() * 400, 300 + Math.random() * 200);
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 500));
        log('Human simulation done');
    } catch (e) {
        log('Human simulation skipped:', e.message);
    }
}

async function waitForCookie(context, page, maxWait, label) {
    const start = Date.now();
    let lastLog = 0;
    while (Date.now() - start < maxWait) {
        const cookies = await context.cookies();
        const vcrcs = cookies.find((c) => c.name === '_vcrcs');
        if (vcrcs?.value) return vcrcs.value;

        const elapsed = Math.floor((Date.now() - start) / 1000);
        if (elapsed - lastLog >= 15) {
            lastLog = elapsed;
            let hint = '';
            if (page) {
                try {
                    const title = await page.title();
                    const url = page.url();
                    hint = ` | page="${title}" url=${url}`;
                } catch { /* ignore */ }
            }
            log(`${label}: 等待 _vcrcs… ${elapsed}s / ${Math.floor(maxWait / 1000)}s${hint}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
}

const chromePath = findSystemChrome();
const launchOptions = {
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
};
if (chromePath) {
    launchOptions.executablePath = chromePath;
    log('Using Chrome:', chromePath);
}
if (!HEADLESS) {
    log('Headed browser — finish any captcha in the window, then wait for cookie');
}

const browser = await chromium.launch(launchOptions);
const context = await browser.newContext({
    userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
    locale: 'zh-CN',
    viewport: { width: 1920, height: 1080 },
});

const page = await context.newPage();
await injectSessionCookie(context);
log('Navigating to', CHALLENGE_URL);
await page.goto(CHALLENGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

await simulateHumanBehavior(page);
let token = await waitForCookie(context, page, CHALLENGE_WAIT, '第 1 轮');

if (!token) {
    log('第 1 轮未拿到 _vcrcs，刷新页面重试…');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await simulateHumanBehavior(page);
    token = await waitForCookie(context, page, CHALLENGE_WAIT, '第 2 轮');
}

if (token) {
    log('成功获取 _vcrcs，长度', token.length);
    process.stdout.write(token);
    await browser.close();
    process.exit(0);
}

try {
    const shotPath = join(process.cwd(), 'vcrcs-debug.png');
    await page.screenshot({ path: shotPath, fullPage: true });
    log('已保存截图:', shotPath);
} catch (e) {
    log('截图失败:', e.message);
}

log(
    'Timeout: _vcrcs not obtained。无头常被 Vercel 拦截，请用有头模式: npm run fetch:vcrcs:headed',
);
await browser.close();
process.exit(1);
