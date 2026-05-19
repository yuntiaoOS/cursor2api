/**
 * Smoke test: Cursor Cloud Agents API (api.cursor.com/v1/agents)
 *
 * Usage:
 *   set CURSOR_API_KEY=crsr_xxx
 *   node test/smoke-cloud-agent.mjs
 *
 * Optional env:
 *   CLOUD_AGENT_REPO_URL     default: https://github.com/yuntiaoOS/cursor2api
 *   CLOUD_AGENT_STARTING_REF default: dev
 *   CLOUD_AGENT_ENV_TYPE     default: machine
 *   CLOUD_AGENT_ENV_NAME     default: cursor2api-pc
 *   CLOUD_AGENT_MODEL        default: composer-2.5
 *   MYKEY_PATH               fallback apikey from GenericAgent mykey.py
 *   SMOKE_TIMEOUT_MS         default: 300000
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_BASE = (process.env.CLOUD_AGENT_API_BASE || 'https://api.cursor.com/v1').replace(/\/$/, '');
const REPO_URL = process.env.CLOUD_AGENT_REPO_URL || 'https://github.com/yuntiaoOS/cursor2api';
const STARTING_REF = process.env.CLOUD_AGENT_STARTING_REF || 'dev';
const ENV_TYPE = (process.env.CLOUD_AGENT_ENV_TYPE || 'machine').trim().toLowerCase();
const ENV_NAME = (process.env.CLOUD_AGENT_ENV_NAME || 'cursor2api-pc').trim();
const MODEL = process.env.CLOUD_AGENT_MODEL || 'composer-2.5';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 300_000);

function resolveApiKey() {
    const fromEnv = (process.env.CURSOR_API_KEY || process.argv[2] || '').trim();
    if (fromEnv) return fromEnv;
    const candidates = [
        process.env.MYKEY_PATH,
        path.resolve(__dirname, '../../comlsdefineGenericAgent/GenericAgent/mykey.py'),
    ].filter(Boolean);
    for (const p of candidates) {
        if (!fs.existsSync(p)) continue;
        const text = fs.readFileSync(p, 'utf8');
        const block = text.match(/cursor_cloud_config\s*=\s*\{[\s\S]*?\n\}/);
        if (!block) continue;
        const m = block[0].match(/['"]apikey['"]\s*:\s*['"]([^'"]+)['"]/);
        if (m?.[1]?.startsWith('crsr_')) return m[1].trim();
    }
    return '';
}

const apiKey = resolveApiKey();
if (!apiKey) {
    console.error('[smoke] 缺少 CURSOR_API_KEY（Dashboard → API Keys，crsr_ 开头）');
    console.error('  PowerShell: $env:CURSOR_API_KEY="crsr_..."; node test/smoke-cloud-agent.mjs');
    process.exit(1);
}
if (!apiKey.toLowerCase().startsWith('crsr_')) {
    console.warn('[smoke] 警告: Cloud Agents 通常需要 crsr_ Dashboard API Key，当前前缀:', apiKey.slice(0, 12));
}

function basicAuth(key) {
    return 'Basic ' + Buffer.from(`${key}:`, 'utf8').toString('base64');
}

async function api(method, path, body) {
    const url = `${API_BASE}/${path.replace(/^\//, '')}`;
    const headers = { Authorization: basicAuth(apiKey) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 500) }; }
    return { status: resp.status, json, text: text.slice(0, 800) };
}

async function streamRun(agentId, runId, deadline) {
    const url = `${API_BASE}/agents/${agentId}/runs/${runId}/stream`;
    const resp = await fetch(url, {
        headers: { Authorization: basicAuth(apiKey), Accept: 'text/event-stream' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`stream HTTP ${resp.status}: ${t.slice(0, 400)}`);
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let eventName = null;
    let assistant = '';
    let status = 'UNKNOWN';
    let done = false;

    while (Date.now() < deadline) {
        const { value, done: rd } = await reader.read();
        if (rd) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        for (const line of lines) {
            if (!line) { eventName = null; continue; }
            if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === '{}' && eventName === 'done') { done = true; break; }
            let data = {};
            try { data = dataStr ? JSON.parse(dataStr) : {}; } catch { /* ignore */ }
            if (eventName === 'assistant' || eventName === 'thinking') {
                const t = data.text || '';
                if (t) {
                    assistant += t;
                    process.stdout.write(t);
                }
            } else if (eventName === 'status' || eventName === 'result') {
                status = String(data.status || status).toUpperCase();
                console.error(`\n[smoke] event=${eventName} status=${status}`);
            } else if (eventName === 'error') {
                throw new Error(`SSE error: ${data.message || JSON.stringify(data)}`);
            }
        }
        if (done) break;
    }
    try { reader.cancel(); } catch { /* ignore */ }
    return { assistant: assistant.trim(), status, done };
}

async function pollRun(agentId, runId, deadline) {
    while (Date.now() < deadline) {
        const r = await api('GET', `agents/${agentId}/runs/${runId}`);
        if (r.status >= 400) throw new Error(`poll HTTP ${r.status}: ${r.text}`);
        const st = String(r.json?.status || '').toUpperCase();
        console.error(`[smoke] poll status=${st}`);
        if (['FINISHED', 'FAILED', 'CANCELLED'].includes(st)) return st;
        await new Promise((res) => setTimeout(res, 2000));
    }
    return 'TIMEOUT';
}

async function main() {
    console.log('[smoke] API base:', API_BASE);
    console.log('[smoke] repo:', REPO_URL, '@', STARTING_REF);
    console.log('[smoke] env:', ENV_TYPE, ENV_NAME || '(none)');
    console.log('[smoke] model:', MODEL);
    console.log('[smoke] key prefix:', apiKey.slice(0, 10) + '...');

    console.log('\n[smoke] Step 1: GET /v0/me');
    const meUrl = 'https://api.cursor.com/v0/me';
    const meResp = await fetch(meUrl, {
        headers: { Authorization: basicAuth(apiKey) },
        signal: AbortSignal.timeout(30_000),
    });
    const meBody = await meResp.text();
    if (!meResp.ok) {
        console.error('[smoke] FAIL /v0/me', meResp.status, meBody.slice(0, 400));
        process.exit(2);
    }
    console.log('[smoke] OK /v0/me', meBody.slice(0, 200));

    console.log('\n[smoke] Step 2: POST /v1/agents');
    const createPayload = {
        prompt: { text: 'Reply with exactly one word: PONG. Do not run tools or edit files.' },
        model: { id: MODEL },
    };
    if (ENV_TYPE && ENV_NAME) {
        createPayload.env = { type: ENV_TYPE, name: ENV_NAME };
    }
    if (REPO_URL) {
        createPayload.repos = [{ url: REPO_URL.replace(/\.git$/, ''), startingRef: STARTING_REF }];
    }
    const created = await api('POST', 'agents', createPayload);
    if (created.status >= 400) {
        console.error('[smoke] FAIL create agent', created.status, created.text);
        process.exit(3);
    }
    const agentId = created.json?.agent?.id;
    const runId = created.json?.run?.id;
    console.log('[smoke] agent_id=', agentId, 'run_id=', runId);
    if (!agentId || !runId) {
        console.error('[smoke] malformed response', JSON.stringify(created.json).slice(0, 500));
        process.exit(4);
    }

    const deadline = Date.now() + TIMEOUT_MS;
    console.log('\n[smoke] Step 3: SSE stream (max', TIMEOUT_MS / 1000, 's)\n---\n');
    let streamResult;
    try {
        streamResult = await streamRun(agentId, runId, deadline);
    } catch (e) {
        console.error('\n[smoke] stream error:', e.message);
        streamResult = { assistant: '', status: 'STREAM_ERROR', done: false };
    }
    console.log('\n---\n');

    if (!streamResult.done && !['FINISHED', 'FAILED', 'CANCELLED'].includes(streamResult.status)) {
        const final = await pollRun(agentId, runId, deadline);
        streamResult.status = final;
    }

    console.log('[smoke] final status:', streamResult.status);
    console.log('[smoke] assistant length:', streamResult.assistant.length);
    if (streamResult.assistant) {
        console.log('[smoke] assistant preview:', streamResult.assistant.slice(0, 300));
    }

    const ok =
        streamResult.status === 'FINISHED' ||
        (streamResult.assistant.length > 0 && streamResult.status !== 'FAILED');
    if (ok) {
        console.log('\n[smoke] PASS — Cloud Agent API Key 可用');
        process.exit(0);
    }
    console.error('\n[smoke] FAIL — run 未成功完成');
    process.exit(5);
}

main().catch((e) => {
    console.error('[smoke] fatal:', e);
    process.exit(99);
});
