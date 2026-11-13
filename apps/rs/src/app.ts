import type { KeyObject } from 'node:crypto';
import express, { type Express } from 'express';
import type { Config } from './lib/config.js';
import { authenticate } from './middleware/authenticate.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { noStore } from './middleware/no-store.js';
import { createMemosRouter } from './routes/memos.js';
import type { MemoStore } from './stores/memo-store.js';

export type AppDeps = {
    config: Config;
    memoStore: MemoStore;
    // AS の公開鍵(アクセストークンの署名を確かめる)
    verifyKey: CryptoKey | KeyObject;
    // 今の時刻(秒)を返す関数。トークンの期限の確認に使う。テスト用。省略したら、本物の時計
    now?: (() => number) | undefined;
};

export function createApp(deps: AppDeps): Express {
    const { config, memoStore, verifyKey } = deps;
    const app = express();

    app.disable('x-powered-by');
    // 返事は、全部(401 や 404 や 500 も)、キャッシュさせない
    app.use(noStore);
    app.use((_req, res, next) => {
        res.set('X-Content-Type-Options', 'nosniff');
        next();
    });

    app.use(
        '/memos',
        authenticate({
            publicKey: verifyKey,
            issuer: config.issuer,
            audience: config.audience,
            realm: config.audience,
            now: deps.now,
            clockToleranceSec: config.clockToleranceSec,
        }),
        createMemosRouter({ memoStore, realm: config.audience }),
    );

    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}
