import type { Express } from 'express';
import { loadConfig, type Config } from './lib/config.js';
import type { CodeStore } from './stores/code-store.js';
import { loadClientsFromEnv } from './clients-from-env.js';
import { importSigningKey } from './lib/signing-key.js';
import { readFile } from 'node:fs/promises';
import { createMemoryClientStore } from './stores/memory-client-store.js';
import { createMemoryCodeStore } from './stores/memory-code-store.js';
import { createApp } from './app.js';

export type BootstrapOptions = {
    // 鍵ファイルを読む関数。テストで差し替えられる
    readFile?: ((path: string) => Promise<string>) | undefined;
};

export type BootstrapResult = {
    app: Express;
    config: Config;
    codeStore: CodeStore;
};

export async function bootstrap(
    env: Record<string, string | undefined>,
    options: BootstrapOptions = {},
): Promise<BootstrapResult> {
    const config = loadConfig(env);
    const clients = loadClientsFromEnv(env);
    let pem: string;
    try {
        pem = await (
            options.readFile ?? ((path: string) => readFile(path, 'utf8'))
        )(config.signingKeyPath);
    } catch (error) {
        throw new Error(
            `署名鍵のファイルを読めませんでした: ${config.signingKeyPath}\n  → 先に \`pnpm --filter @oauth/as gen:key\` で、鍵を作ってください`,
            { cause: error },
        );
    }
    let signingKey;
    try {
        signingKey = await importSigningKey(pem);
    } catch (error) {
        throw new Error(`署名鍵の形式が不正です: ${config.signingKeyPath}`, {
            cause: error,
        });
    }

    const clientStore = createMemoryClientStore(clients);
    const codeStore = createMemoryCodeStore();

    const app = createApp({ config, clientStore, codeStore, signingKey });

    return { app, config, codeStore };
}
