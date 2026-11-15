import express, { type Express } from 'express';
import type { Config } from './lib/config.js';
import { notFoundHandler, pageErrorHandler } from './lib/page-errors.js';
import { securityHeaders } from './lib/security-headers.js';
import { createSessionMiddleware } from './lib/session.js';
import { configureViews } from './lib/views.js';
import { createCallbackRouter } from './routes/callback.js';
import { createDetailRouter } from './routes/detail.js';
import { createHomeRouter } from './routes/home.js';
import { createLoginRouter } from './routes/login.js';
import { createLogoutRouter } from './routes/logout.js';
import type { MemoApi } from './rs/memo-api.js';

export type AppDeps = {
    config: Config;
    // RS(シンプルメモアプリ)の API を呼ぶ物
    memoApi: MemoApi;
    // 今の時刻(秒)を返す関数。トークンの期限の確認に使う。テスト用。省略したら、本物の時計
    now?: (() => number) | undefined;
};

export function createApp(deps: AppDeps): Express {
    const { config, memoApi, now } = deps;
    const app = express();

    configureViews(app);
    app.use(securityHeaders());
    app.use(
        createSessionMiddleware({
            secret: config.sessionSecret,
            // https の時だけ Secure 属性を付ける(http のまま付けると、Cookie が出なくなる)
            secure: new URL(config.baseUrl).protocol === 'https:',
        }),
    );

    app.use(
        '/login',
        createLoginRouter({
            clientId: config.clientId,
            redirectUri: config.redirectUri,
            authorizationEndpoint: config.authorizationEndpoint,
            requestedScope: config.requestedScope,
            now,
        }),
    );
    app.use(
        '/callback',
        createCallbackRouter({
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri,
            tokenEndpoint: config.tokenEndpoint,
        }),
    );
    app.use('/logout', createLogoutRouter());
    app.use('/detail', createDetailRouter({ memoApi, now }));
    app.use('/', createHomeRouter({ memoApi, now }));

    app.use(notFoundHandler);
    app.use(pageErrorHandler);
    return app;
}
