/**
 * vcrcs-fetcher.ts - 通过 stealth-proxy 子进程获取 Vercel _vcrcs Cookie
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const FETCH_SCRIPT = join(process.cwd(), 'stealth-proxy', 'fetch-vcrcs.mjs');

/**
 * 调用 Playwright 子进程获取 _vcrcs 值（约 30–120 秒）
 */
export function fetchVcrcsValue(): Promise<string> {
    if (!existsSync(FETCH_SCRIPT)) {
        return Promise.reject(new Error(`未找到 ${FETCH_SCRIPT}，请先执行 npm install`));
    }

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [FETCH_SCRIPT], {
            cwd: join(process.cwd(), 'stealth-proxy'),
            env: { ...process.env },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk: Buffer) => {
            const line = chunk.toString();
            stderr += line;
            process.stderr.write(line);
        });

        child.on('error', reject);
        child.on('close', (code) => {
            const value = stdout.trim();
            if (code === 0 && value) {
                resolve(value);
                return;
            }
            reject(
                new Error(
                    code !== 0
                        ? `fetch-vcrcs 退出码 ${code}${stderr ? `: ${stderr.slice(-200)}` : ''}`
                        : 'fetch-vcrcs 未返回 _vcrcs 值',
                ),
            );
        });
    });
}
