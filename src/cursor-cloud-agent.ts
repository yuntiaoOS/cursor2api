/**
 * Cursor Cloud Agents API client (api.cursor.com/v1/agents)
 */

import type { AppConfig, CloudAgentConfig } from './types.js';
import { getConfig } from './config.js';

const TERMINAL_STATES = new Set(['FINISHED', 'FAILED', 'CANCELLED']);

export class CursorCloudAgentError extends Error {
    constructor(
        message: string,
        readonly statusCode?: number,
        readonly body?: string,
    ) {
        super(message);
        this.name = 'CursorCloudAgentError';
    }
}

interface AgentSession {
    agentId: string;
    latestRunId?: string;
    updatedAt: number;
}

const sessions = new Map<string, AgentSession>();

function basicAuth(apiKey: string): string {
    return 'Basic ' + Buffer.from(`${apiKey}:`, 'utf8').toString('base64');
}

export function isCloudAgentEnabled(cfg: AppConfig = getConfig()): boolean {
    return !!cfg.cloudAgent?.enabled && !!cfg.apiKey?.trim();
}

export function resolveCloudAgentConfig(cfg: AppConfig = getConfig()): CloudAgentConfig {
    const ca = cfg.cloudAgent;
    if (!ca) {
        throw new CursorCloudAgentError('cloud_agent 未配置');
    }
    return ca;
}

function apiBase(cfg: CloudAgentConfig): string {
    return cfg.apiBase.replace(/\/$/, '');
}

async function apiJson(
    cfg: CloudAgentConfig,
    apiKey: string,
    method: string,
    path: string,
    body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
    const url = `${apiBase(cfg)}/${path.replace(/^\//, '')}`;
    const headers: Record<string, string> = { Authorization: basicAuth(apiKey) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const timeoutMs = cfg.readTimeoutSec * 1000;
    const resp = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    let json: Record<string, unknown> | null = null;
    try {
        json = text ? JSON.parse(text) as Record<string, unknown> : null;
    } catch {
        json = null;
    }
    return { status: resp.status, json, text };
}

function assertOk(
    result: { status: number; text: string },
    action: string,
): void {
    if (result.status < 400) return;
    throw new CursorCloudAgentError(
        `${action}: HTTP ${result.status}${result.text ? ` — ${result.text.slice(0, 400)}` : ''}`,
        result.status,
        result.text,
    );
}

function buildCreatePayload(cfg: CloudAgentConfig, promptText: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
        prompt: { text: promptText },
        model: { id: cfg.model },
    };
    if (cfg.modelParams?.length) {
        (payload.model as Record<string, unknown>).params = cfg.modelParams;
    }
    const namedCloud =
        cfg.envType === 'cloud' && !!cfg.envName;
    if (cfg.envType && cfg.envName) {
        payload.env = { type: cfg.envType, name: cfg.envName };
    }
    if (!namedCloud && cfg.repoUrl) {
        payload.repos = [{
            url: cfg.repoUrl.replace(/\.git$/, ''),
            ...(cfg.startingRef ? { startingRef: cfg.startingRef } : {}),
        }];
    } else if (!namedCloud && !cfg.repoUrl) {
        throw new CursorCloudAgentError('cloud_agent 需要 repo_url，或 env_type=cloud 且配置 env_name');
    }
    return payload;
}

function pruneSessions(ttlSec: number): void {
    const cutoff = Date.now() - ttlSec * 1000;
    for (const [k, v] of sessions) {
        if (v.updatedAt < cutoff) sessions.delete(k);
    }
}

export function getCloudAgentSession(sessionKey: string): string | undefined {
    return sessions.get(sessionKey)?.agentId;
}

export function setCloudAgentSession(sessionKey: string, agentId: string): void {
    const existing = sessions.get(sessionKey);
    sessions.set(sessionKey, {
        agentId,
        latestRunId: existing?.latestRunId,
        updatedAt: Date.now(),
    });
}

async function pollRunUntilTerminal(
    cfg: CloudAgentConfig,
    apiKey: string,
    agentId: string,
    runId: string,
): Promise<string> {
    for (let i = 0; i < 180; i++) {
        const r = await apiJson(cfg, apiKey, 'GET', `agents/${agentId}/runs/${runId}`);
        assertOk(r, 'poll run');
        const status = String(r.json?.status ?? '').toUpperCase();
        if (TERMINAL_STATES.has(status)) return status;
        await new Promise((res) => setTimeout(res, 1000));
    }
    return 'TIMEOUT';
}

async function waitForAgentIdle(
    cfg: CloudAgentConfig,
    apiKey: string,
    agentId: string,
    latestRunId?: string,
): Promise<void> {
    if (latestRunId) {
        await pollRunUntilTerminal(cfg, apiKey, agentId, latestRunId);
        return;
    }
    await new Promise((res) => setTimeout(res, cfg.agentBusyDelaySec * 1000));
}

async function createAgentAndRun(
    cfg: CloudAgentConfig,
    apiKey: string,
    promptText: string,
): Promise<{ agentId: string; runId: string }> {
    const r = await apiJson(cfg, apiKey, 'POST', 'agents', buildCreatePayload(cfg, promptText));
    assertOk(r, 'create agent');
    const agentId = (r.json?.agent as { id?: string } | undefined)?.id;
    const runId = (r.json?.run as { id?: string } | undefined)?.id;
    if (!agentId || !runId) {
        throw new CursorCloudAgentError(`create agent 响应异常: ${JSON.stringify(r.json).slice(0, 500)}`);
    }
    return { agentId, runId };
}

async function createFollowupRun(
    cfg: CloudAgentConfig,
    apiKey: string,
    agentId: string,
    promptText: string,
    latestRunId?: string,
): Promise<string> {
    const path = `agents/${agentId}/runs`;
    const payload = { prompt: { text: promptText } };
    let lastRunId = latestRunId;
    for (let attempt = 0; attempt < cfg.agentBusyRetries; attempt++) {
        const r = await apiJson(cfg, apiKey, 'POST', path, payload);
        if (r.status === 409) {
            await waitForAgentIdle(cfg, apiKey, agentId, lastRunId);
            continue;
        }
        assertOk(r, 'create run');
        const runId = (r.json?.run as { id?: string } | undefined)?.id;
        if (!runId) {
            throw new CursorCloudAgentError(`create run 响应异常: ${JSON.stringify(r.json).slice(0, 500)}`);
        }
        return runId;
    }
    throw new CursorCloudAgentError(
        `agent_busy: ${cfg.agentBusyRetries} 次重试后仍忙碌`,
    );
}

export interface CloudAgentStreamCallbacks {
    onAssistantText?: (text: string) => void;
    onThinkingText?: (text: string) => void;
    onStatus?: (status: string) => void;
}

interface StreamState {
    content: string;
    thinking: string;
    status: string;
    lastEventId: string | null;
    done: boolean;
    failed: boolean;
    errorText: string;
    streamExpired: boolean;
}

function handleSseEvent(
    eventName: string | null,
    data: Record<string, unknown>,
    state: StreamState,
    callbacks: CloudAgentStreamCallbacks,
): void {
    if (eventName === 'assistant') {
        const text = String(data.text ?? '');
        if (text) {
            state.content += text;
            callbacks.onAssistantText?.(text);
        }
    } else if (eventName === 'thinking') {
        const text = String(data.text ?? '');
        if (text) {
            state.thinking += text;
            callbacks.onThinkingText?.(text);
        }
    } else if (eventName === 'status' || eventName === 'result') {
        state.status = String(data.status ?? state.status).toUpperCase();
        callbacks.onStatus?.(state.status);
    } else if (eventName === 'error') {
        state.failed = true;
        state.errorText = String(data.message ?? JSON.stringify(data));
    }
}

async function consumeSseResponse(
    resp: Response,
    state: StreamState,
    callbacks: CloudAgentStreamCallbacks,
): Promise<void> {
    const reader = resp.body?.getReader();
    if (!reader) throw new CursorCloudAgentError('SSE 响应无 body');
    const dec = new TextDecoder();
    let buf = '';
    let eventName: string | null = null;

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() ?? '';
        for (const line of lines) {
            if (!line) {
                eventName = null;
                continue;
            }
            if (line.startsWith('id:')) {
                state.lastEventId = line.slice(3).trim();
                continue;
            }
            if (line.startsWith('event:')) {
                eventName = line.slice(6).trim();
                continue;
            }
            if (!line.startsWith('data:')) continue;
            const dataStr = line.slice(5).trim();
            if (dataStr === '{}' && eventName === 'done') {
                state.done = true;
                return;
            }
            let data: Record<string, unknown> = {};
            try {
                data = dataStr ? JSON.parse(dataStr) as Record<string, unknown> : {};
            } catch { /* ignore */ }
            handleSseEvent(eventName, data, state, callbacks);
            if (state.failed || state.done) return;
        }
    }
}

async function openSseStream(
    cfg: CloudAgentConfig,
    apiKey: string,
    agentId: string,
    runId: string,
    state: StreamState,
    callbacks: CloudAgentStreamCallbacks,
): Promise<void> {
    const url = `${apiBase(cfg)}/agents/${agentId}/runs/${runId}/stream`;
    const headers: Record<string, string> = {
        Authorization: basicAuth(apiKey),
        Accept: 'text/event-stream',
    };
    if (state.lastEventId) headers['Last-Event-ID'] = state.lastEventId;

    const resp = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(cfg.readTimeoutSec * 1000),
    });

    if (resp.status === 410) {
        state.streamExpired = true;
        return;
    }
    if (resp.status === 400) {
        const body = (await resp.text()).toLowerCase();
        if (body.includes('invalid_last_event_id')) {
            state.lastEventId = null;
            return;
        }
    }
    if (!resp.ok) {
        const body = await resp.text();
        throw new CursorCloudAgentError(
            `stream HTTP ${resp.status}: ${body.slice(0, 400)}`,
            resp.status,
            body,
        );
    }
    await consumeSseResponse(resp, state, callbacks);
}

export interface CloudAgentRunResult {
    assistantText: string;
    thinkingText: string;
    status: string;
    agentId: string;
    runId: string;
    failed: boolean;
    errorText?: string;
}

export async function runCloudAgentChat(options: {
    promptText: string;
    sessionKey: string;
    existingAgentId?: string;
    callbacks?: CloudAgentStreamCallbacks;
}): Promise<CloudAgentRunResult> {
    const cfg = getConfig();
    const ca = resolveCloudAgentConfig(cfg);
    const apiKey = cfg.apiKey!.trim();
    pruneSessions(ca.sessionTtlSec);

    let agentId = options.existingAgentId;
    let latestRunId: string | undefined;
    const session = sessions.get(options.sessionKey);
    if (!agentId && session) {
        agentId = session.agentId;
        latestRunId = session.latestRunId;
    }

    let runId: string;
    if (!agentId) {
        const created = await createAgentAndRun(ca, apiKey, options.promptText);
        agentId = created.agentId;
        runId = created.runId;
    } else {
        runId = await createFollowupRun(ca, apiKey, agentId, options.promptText, latestRunId);
    }

    const state: StreamState = {
        content: '',
        thinking: '',
        status: 'UNKNOWN',
        lastEventId: null,
        done: false,
        failed: false,
        errorText: '',
        streamExpired: false,
    };

    const callbacks = options.callbacks ?? {};

    for (let resume = 0; resume <= ca.streamResumeRetries; resume++) {
        try {
            await openSseStream(ca, apiKey, agentId, runId, state, callbacks);
        } catch (err) {
            if (resume >= ca.streamResumeRetries) throw err;
            await new Promise((res) => setTimeout(res, Math.min(2 ** (resume + 1) * 1000, 8000)));
            continue;
        }
        if (state.failed) break;
        if (state.done || TERMINAL_STATES.has(state.status)) break;
        if (state.streamExpired && resume < ca.streamResumeRetries) {
            await new Promise((res) => setTimeout(res, Math.min(2 ** (resume + 1) * 1000, 8000)));
            continue;
        }
        break;
    }

    if (!state.done && !TERMINAL_STATES.has(state.status)) {
        state.status = await pollRunUntilTerminal(ca, apiKey, agentId, runId);
    }

    sessions.set(options.sessionKey, { agentId, latestRunId: runId, updatedAt: Date.now() });

    const failed = state.failed || state.status === 'FAILED';
    return {
        assistantText: state.failed ? state.errorText : state.content.trim(),
        thinkingText: state.thinking.trim(),
        status: state.status,
        agentId,
        runId,
        failed,
        errorText: state.failed ? state.errorText : undefined,
    };
}
