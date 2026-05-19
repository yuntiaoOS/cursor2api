/**
 * Cloud Agent 模式 — Anthropic / OpenAI 入口
 */

import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AnthropicRequest, AnthropicResponse, AnthropicContentBlock } from './types.js';
import type { OpenAIChatRequest } from './openai-types.js';
import { convertToAnthropicRequest } from './openai-handler.js';
import { getConfig } from './config.js';
import { createRequestLogger, type RequestLogger } from './logger.js';
import { runCloudAgentChat, getCloudAgentSession, isCloudAgentEnabled } from './cursor-cloud-agent.js';
import { sanitizeResponse } from './handler.js';

function msgId(): string {
    return 'msg_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function chatId(): string {
    return 'chatcmpl-' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function writeSSE(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function blockToText(block: AnthropicContentBlock): string {
    if (block.type === 'text' && block.text) return block.text;
    if (block.type === 'tool_use') {
        return `<tool_use>${JSON.stringify({ name: block.name, arguments: block.input ?? {} })}</tool_use>`;
    }
    if (block.type === 'tool_result') {
        const c = block.content;
        const tr = typeof c === 'string'
            ? c
            : Array.isArray(c)
                ? c.map((b) => (typeof b === 'object' && b && 'text' in b ? String(b.text) : '')).join('\n')
                : String(c ?? '');
        return `<tool_result tool_use_id="${block.tool_use_id ?? ''}">${tr}</tool_result>`;
    }
    if (block.type === 'image') return '[image omitted for Cloud Agent]';
    return '';
}

export function anthropicMessagesToPrompt(body: AnthropicRequest): string {
    const parts: string[] = [];
    if (body.system) {
        if (typeof body.system === 'string') parts.push(`=== SYSTEM ===\n${body.system}`);
        else {
            const sys = body.system.map((b) => blockToText(b)).filter(Boolean).join('\n');
            if (sys) parts.push(`=== SYSTEM ===\n${sys}`);
        }
    }
    const cfg = getConfig();
    if (cfg.systemPrompt) {
        parts.push(`=== SYSTEM (config) ===\n${cfg.systemPrompt}`);
    }
    for (const msg of body.messages) {
        const role = msg.role.toUpperCase();
        if (typeof msg.content === 'string') {
            parts.push(`=== ${role} ===\n${msg.content}`);
        } else {
            const text = msg.content.map((b) => blockToText(b)).filter(Boolean).join('\n');
            parts.push(`=== ${role} ===\n${text}`);
        }
    }
    if (body.tools?.length) {
        parts.push(
            `\n=== TOOLS (client-side; Cloud Agent runs tools in its own environment) ===\n${
                JSON.stringify(body.tools.map((t) => t.name))
            }`,
        );
    }
    return parts.join('\n\n').trim() || '(empty prompt)';
}

export function resolveCloudAgentSessionKey(req: Request, body: AnthropicRequest): string {
    const agentHdr = req.headers['x-cursor-agent-id'];
    if (typeof agentHdr === 'string' && agentHdr.trim()) {
        return `agent:${agentHdr.trim()}`;
    }
    const sessHdr = req.headers['x-cursor-session-id'];
    if (typeof sessHdr === 'string' && sessHdr.trim()) {
        return `sess:${sessHdr.trim()}`;
    }
    const uid = body.metadata?.user_id;
    if (typeof uid === 'string' && uid.trim()) return `user:${uid.trim()}`;
    const firstUser = body.messages.find((m) => m.role === 'user');
    const seed = JSON.stringify({
        sys: body.system,
        first: firstUser?.content,
    }).slice(0, 2000);
    return `hash:${Buffer.from(seed).toString('base64url').slice(0, 32)}`;
}

export async function handleCloudAgentMessages(req: Request, res: Response): Promise<void> {
    const body = req.body as AnthropicRequest;
    const log = createRequestLogger({
        method: req.method,
        path: req.path,
        model: body.model,
        stream: !!body.stream,
        hasTools: (body.tools?.length ?? 0) > 0,
        toolCount: body.tools?.length ?? 0,
        messageCount: body.messages?.length ?? 0,
        apiFormat: 'anthropic',
        systemPromptLength: 0,
    });

    log.info('Cursor', 'send', 'Cloud Agent 模式', {
        model: getConfig().cloudAgent?.model,
        stream: body.stream,
    });

    const promptText = anthropicMessagesToPrompt(body);
    const sessionKey = resolveCloudAgentSessionKey(req, body);
    const existingAgentId = getCloudAgentSession(sessionKey);

    if (body.stream) {
        await handleCloudAgentStream(res, body, promptText, sessionKey, existingAgentId, log);
    } else {
        await handleCloudAgentNonStream(res, body, promptText, sessionKey, existingAgentId, log);
    }
}

async function handleCloudAgentStream(
    res: Response,
    body: AnthropicRequest,
    promptText: string,
    sessionKey: string,
    existingAgentId: string | undefined,
    log: RequestLogger,
): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const messageId = msgId();
    writeSSE(res, 'message_start', {
        type: 'message_start',
        message: {
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: body.model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    });

    const streamState = { blockIndex: 0, textBlockStarted: false, thinkingEmitted: false };
    let fullText = '';
    let fullThinking = '';

    const emitThinking = (chunk: string) => {
        if (!chunk || streamState.thinkingEmitted) return;
        if (!streamState.thinkingEmitted) {
            writeSSE(res, 'content_block_start', {
                type: 'content_block_start',
                index: streamState.blockIndex,
                content_block: { type: 'thinking', thinking: '' },
            });
            streamState.thinkingEmitted = true;
        }
        writeSSE(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: streamState.blockIndex,
            delta: { type: 'thinking_delta', thinking: chunk },
        });
    };

    const emitText = (chunk: string) => {
        const text = sanitizeResponse(chunk);
        if (!text) return;
        fullText += text;
        if (!streamState.textBlockStarted) {
            writeSSE(res, 'content_block_start', {
                type: 'content_block_start',
                index: streamState.blockIndex,
                content_block: { type: 'text', text: '' },
            });
            streamState.textBlockStarted = true;
        }
        writeSSE(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: streamState.blockIndex,
            delta: { type: 'text_delta', text },
        });
    };

    try {
        const result = await runCloudAgentChat({
            promptText,
            sessionKey,
            existingAgentId,
            callbacks: {
                onThinkingText: (t) => {
                    fullThinking += t;
                    if (body.thinking?.type === 'enabled') emitThinking(t);
                },
                onAssistantText: emitText,
            },
        });

        res.setHeader('X-Cursor-Agent-Id', result.agentId);
        res.setHeader('X-Cursor-Run-Id', result.runId);

        if (streamState.thinkingEmitted) {
            writeSSE(res, 'content_block_stop', {
                type: 'content_block_stop',
                index: streamState.blockIndex,
            });
            streamState.blockIndex++;
        }

        if (!fullText && result.failed) {
            emitText(result.assistantText || `Cloud Agent run failed (${result.status})`);
        }

        if (streamState.textBlockStarted) {
            writeSSE(res, 'content_block_stop', {
                type: 'content_block_stop',
                index: streamState.blockIndex,
            });
        }

        const stopReason = result.failed ? 'end_turn' : 'end_turn';
        writeSSE(res, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: Math.ceil(fullText.length / 4) },
        });
        writeSSE(res, 'message_stop', { type: 'message_stop' });
        log.complete(fullText.length, result.status);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        writeSSE(res, 'error', { type: 'error', error: { type: 'api_error', message } });
    }
    res.end();
}

async function handleCloudAgentNonStream(
    res: Response,
    body: AnthropicRequest,
    promptText: string,
    sessionKey: string,
    existingAgentId: string | undefined,
    log: RequestLogger,
): Promise<void> {
    try {
        const result = await runCloudAgentChat({
            promptText,
            sessionKey,
            existingAgentId,
        });

        res.setHeader('X-Cursor-Agent-Id', result.agentId);
        res.setHeader('X-Cursor-Run-Id', result.runId);

        let text = result.failed
            ? (result.assistantText || `Cloud Agent run failed (${result.status})`)
            : sanitizeResponse(result.assistantText);
        if (!text) text = '(empty response from Cloud Agent)';

        const content: AnthropicContentBlock[] = [];
        if (body.thinking?.type === 'enabled' && result.thinkingText) {
            content.push({ type: 'thinking', thinking: result.thinkingText });
        }
        content.push({ type: 'text', text });

        const response: AnthropicResponse = {
            id: msgId(),
            type: 'message',
            role: 'assistant',
            content,
            model: body.model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
                input_tokens: Math.ceil(promptText.length / 4),
                output_tokens: Math.ceil(text.length / 4),
            },
        };
        log.complete(text.length, result.status);
        res.json(response);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message },
        });
    }
}

export async function handleCloudAgentOpenAIChat(req: Request, res: Response): Promise<void> {
    const body = req.body as OpenAIChatRequest;
    const anthropicReq = convertToAnthropicRequest(body);
    const fakeReq = { ...req, body: anthropicReq } as Request;
    if (body.stream) {
        const promptText = anthropicMessagesToPrompt(anthropicReq);
        const sessionKey = resolveCloudAgentSessionKey(req, anthropicReq);
        const existingAgentId = getCloudAgentSession(sessionKey);

        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const id = chatId();
        const created = Math.floor(Date.now() / 1000);
        const writeChunk = (content: string | null, finish: string | null) => {
            res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model: body.model,
                choices: [{
                    index: 0,
                    delta: content != null ? { content } : {},
                    finish_reason: finish,
                }],
            })}\n\n`);
        };
        writeChunk(null, null);
        res.write(`data: ${JSON.stringify({
            id, object: 'chat.completion.chunk', created, model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        })}\n\n`);

        try {
            const result = await runCloudAgentChat({
                promptText,
                sessionKey,
                existingAgentId,
                callbacks: {
                    onAssistantText: (t) => writeChunk(sanitizeResponse(t), null),
                },
            });
            res.setHeader('X-Cursor-Agent-Id', result.agentId);
            writeChunk(null, result.failed ? 'stop' : 'stop');
            res.write('data: [DONE]\n\n');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            writeChunk(`Error: ${msg}`, 'stop');
            res.write('data: [DONE]\n\n');
        }
        res.end();
        return;
    }

    const promptText = anthropicMessagesToPrompt(anthropicReq);
    const sessionKey = resolveCloudAgentSessionKey(req, anthropicReq);
    const log = createRequestLogger({
        method: req.method,
        path: req.path,
        model: body.model,
        stream: false,
        hasTools: (body.tools?.length ?? 0) > 0,
        toolCount: body.tools?.length ?? 0,
        messageCount: body.messages?.length ?? 0,
        apiFormat: 'openai',
        systemPromptLength: 0,
    });
    try {
        const result = await runCloudAgentChat({
            promptText,
            sessionKey,
            existingAgentId: getCloudAgentSession(sessionKey),
        });
        res.setHeader('X-Cursor-Agent-Id', result.agentId);
        res.setHeader('X-Cursor-Run-Id', result.runId);
        const text = result.failed
            ? (result.assistantText || `Cloud Agent failed (${result.status})`)
            : sanitizeResponse(result.assistantText) || '(empty)';
        const response = {
            id: chatId(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{
                index: 0,
                message: { role: 'assistant' as const, content: text },
                finish_reason: 'stop',
            }],
            usage: {
                prompt_tokens: Math.ceil(promptText.length / 4),
                completion_tokens: Math.ceil(text.length / 4),
                total_tokens: Math.ceil((promptText.length + text.length) / 4),
            },
        };
        log.complete(text.length, result.status);
        res.json(response);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.fail(message);
        res.status(500).json({ error: { message, type: 'server_error' } });
    }
}
