import express, { type Express } from 'express';
import type { Config } from './lib/config.js';
import type { SigningKey } from './lib/signing-key.js';
import { createTokenRouter } from './routes/token.js';
import type { ClientStore } from './stores/client-store.js';
import type { CodeStore } from './stores/code-store.js';

export type AppDeps = {
    config: Config;
    clientStore: ClientStore;
    codeStore: CodeStore;
    signingKey: SigningKey;
    now?: (() => number) | undefined; // テスト用の今の時刻を返す関数
};

export function createApp(deps: AppDeps): Express {
    const app = express();
    app.use('/token', createTokenRouter(deps));
    return app;
}
