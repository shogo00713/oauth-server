import { readFile } from 'node:fs/promises';
import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig, type Config } from './lib/config.js';
import { importVerifyKey } from './lib/verify-key.js';
import { createMemoryMemoStore } from './stores/memory-memo-store.js';

export type BootstrapOptions = {
    // 公開鍵のファイルを読む関数。テストで差し替えられる
    readFile?: ((path: string) => Promise<string>) | undefined;
};

export type BootstrapResult = {
    app: Express;
    config: Config;
};

export async function bootstrap(
    env: Record<string, string | undefined>,
    options: BootstrapOptions = {},
): Promise<BootstrapResult> {
    const config = loadConfig(env);

    let pem: string;
    try {
        pem = await (
            options.readFile ?? ((path: string) => readFile(path, 'utf8'))
        )(config.verifyKeyPath);
    } catch (error) {
        throw new Error(
            `AS の公開鍵のファイルを読めませんでした: ${config.verifyKeyPath}\n  → 先に \`pnpm --filter @oauth/as gen:key\` で、鍵を作ってください(公開鍵は keys/as-public.pem)`,
            { cause: error },
        );
    }

    let verifyKey;
    try {
        verifyKey = await importVerifyKey(pem);
    } catch (error) {
        throw new Error(
            `AS の公開鍵の形式が不正です: ${config.verifyKeyPath}`,
            { cause: error },
        );
    }

    const memoStore = createMemoryMemoStore();
    const app = createApp({ config, memoStore, verifyKey });

    return { app, config };
}
