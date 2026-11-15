import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig, type Config } from './lib/config.js';
import { createMemoApi } from './rs/memo-api.js';

export type BootstrapResult = {
    app: Express;
    config: Config;
};

/**
 * 環境変数から、設定を読んで、app を組み立てる(サーバーは、まだ起動しない)
 * 環境変数が不正なら、例外を投げる(メッセージに、悪い環境変数の名前が入る)
 */
export function bootstrap(
    env: Record<string, string | undefined>,
): BootstrapResult {
    const config = loadConfig(env);
    const memoApi = createMemoApi({ baseUrl: config.rsBaseUrl });
    const app = createApp({ config, memoApi });

    return { app, config };
}
