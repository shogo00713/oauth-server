/**
 * AS の起動時に、環境変数や鍵の読み取りを行うプログラム
 */

import type { Express } from 'express';
import { readFile } from 'node:fs/promises';

import { loadConfig, type Config } from './lib/config.js';
import { loadClientsFromEnv } from './clients-from-env.js';
import { loadUsersFromEnv } from './users-from-env.js';
import { importSigningKey } from './lib/signing-key.js';

import type { CodeStore } from './stores/code-store.js';
import { createMemoryClientStore } from './stores/memory-client-store.js';
import { createMemoryCodeStore } from './stores/memory-code-store.js';
import { createMemoryUserStore } from './stores/memory-user-store.js';

import { createApp } from './app.js';

// テスト用に、鍵の場所を別途指定するためのオプション
export type BootstrapOptions = {
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
    // 環境変数の読み込み
    const config = loadConfig(env);
    const clients = loadClientsFromEnv(env);
    const users = await loadUsersFromEnv(env);

    // pem の読み込み
    let pem: string;
    try {
        pem = await (
            options.readFile ?? ((path: string) => readFile(path, 'utf8'))
        )(config.signingKeyPath);
    } catch (error) {
        throw new Error(
            `--------------------------------\n
鍵ファイルの読み込みに失敗しました\n
先に pnpm --filter @oauth/as gen:key を実行して、鍵を作成してください\n
--------------------------------`,
            { cause: error },
        );
    }

    // key の読み込み
    let signingKey;
    try {
        signingKey = await importSigningKey(pem);
    } catch (error) {
        throw new Error(`鍵の形式が不正です: ${config.signingKeyPath}`, {
            cause: error,
        });
    }

    // メモリ上のストアの作成
    const clientStore = createMemoryClientStore(clients);
    const codeStore = createMemoryCodeStore();
    const userStore = createMemoryUserStore(users);

    // 読み込んだ情報を元にアプリの作成
    const app = createApp({
        config,
        clientStore,
        codeStore,
        userStore,
        signingKey,
    });

    return { app, config, codeStore };
}
