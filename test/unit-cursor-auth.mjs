/**
 * test/unit-cursor-auth.mjs
 * 运行: npx tsx test/unit-cursor-auth.mjs
 */

import {
    buildCursorCookie,
    getVcrcsExpiry,
    hasVcrcsCookie,
    isBareVcrcsValue,
    isCrsrApiKey,
    mergeCookiePair,
    normalizeCursorCookieInput,
    normalizeSessionToken,
    WORKOS_SESSION_COOKIE,
    VCRCS_COOKIE,
} from '../src/cursor-auth.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌  ${name}`);
        console.error(`      ${e.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
    if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

console.log('\n  cursor-auth 单元测试\n');

test('crsr_ API Key 不写入 WorkosCursorSessionToken', () => {
    const c = buildCursorCookie({
        sessionToken: 'crsr_abc123',
        cookie: '_vcrcs=old',
    });
    assert(!c.includes('WorkosCursorSessionToken'));
    assert(hasVcrcsCookie(c));
});

test('Workos 格式 session 正常合并', () => {
    const c = buildCursorCookie({ sessionToken: 'user%3A%3AeyJhbGciOiJIUzI1NiJ9' });
    assert(c.includes(`${WORKOS_SESSION_COOKIE}=user%3A%3A`));
});

test('完整 name=value 输入可解析', () => {
    const v = normalizeSessionToken(`${WORKOS_SESSION_COOKIE}=crsr_xyz`);
    assertEqual(v, 'crsr_xyz');
});

test('已有 cookie 时合并并覆盖同名 session', () => {
    const c = buildCursorCookie({
        cookie: '_vcrcs=old; WorkosCursorSessionToken=obsolete',
        sessionToken: 'user%3A%3Anewjwt',
    });
    assert(c.includes('_vcrcs=old'));
    assert(c.includes('WorkosCursorSessionToken=user%3A%3Anewjwt'));
    assert(!c.includes('obsolete'));
});

test('仅 cookie 无 token 时原样返回', () => {
    const raw = '_vcrcs=vc1; foo=bar';
    assertEqual(buildCursorCookie({ cookie: raw }), raw);
});

test('mergeCookiePair 追加新键', () => {
    assertEqual(
        mergeCookiePair('a=1', WORKOS_SESSION_COOKIE, 'tok'),
        `a=1; ${WORKOS_SESSION_COOKIE}=tok`,
    );
});

test('空输入返回 undefined', () => {
    assertEqual(buildCursorCookie({}), undefined);
});

test('hasVcrcsCookie 检测 _vcrcs', () => {
    assert(!hasVcrcsCookie('WorkosCursorSessionToken=abc'));
    assert(hasVcrcsCookie('_vcrcs=xyz; WorkosCursorSessionToken=abc'));
});

test('解析 _vcrcs 过期时间', () => {
    const exp = getVcrcsExpiry('_vcrcs=1.1000.3600.abc.def');
    assert(exp instanceof Date);
    assertEqual(exp.getTime(), (1000 + 3600) * 1000);
});

test('仅粘贴 _vcrcs 值时自动补前缀', () => {
    const bare = '1.1779073830.3600.NTQxN2NjMzhmMzMzM2Y1NmIxN2Q4ZDI3NmNhMGY3NGQ=.59d01c64';
    assert(isBareVcrcsValue(bare));
    const normalized = normalizeCursorCookieInput(bare);
    assert(hasVcrcsCookie(normalized));
    assert(normalized.startsWith(`${VCRCS_COOKIE}=`));
});

console.log(`\n  结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
