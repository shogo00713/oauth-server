import { readFile } from 'node:fs/promises';
import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig, type Config } from './lib/config.js';
import { importVerifyKey } from './lib/verify-key.js';
import { createSqliteMemoStore } from './stores/sqlite-memo-store.js';

export type BootstrapOptions = {
    // 公開鍵のファイルを読む関数。テストで差し替えられる
    readFile?: ((path: string) => Promise<string>) | undefined;
};

export type BootstrapResult = {
    app: Express;
    config: Config;
    // データベースを閉じる(止める時に呼ぶ。2 回呼んでも、良い)
    close: () => void;
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

    // データベースは、最後に開く(設定や鍵が不正な時に、ファイルを作らないため)
    const memoStore = createSqliteMemoStore({ path: config.dbPath });
    const app = createApp({ config, memoStore, verifyKey });

    return { app, config, close: () => memoStore.close() };
}
