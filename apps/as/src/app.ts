import express, { type Express } from 'express';
import type { Config } from './lib/config.js';
import { notFoundHandler, pageErrorHandler } from './lib/page-errors.js';
import { SUPPORTED_SCOPES } from './lib/scope.js';
import { securityHeaders } from './lib/security-headers.js';
import { createSessionMiddleware } from './lib/session.js';
import type { SigningKey } from './lib/signing-key.js';
import { configureViews } from './lib/views.js';
import { createAuthorizeRouter } from './routes/authorize.js';
import { createConsentRouter } from './routes/consent.js';
import { createLoginRouter } from './routes/login.js';
import { createTokenRouter } from './routes/token.js';
import type { ClientStore } from './stores/client-store.js';
import type { CodeStore } from './stores/code-store.js';
import type { UserStore } from './stores/user-store.js';

export type AppDeps = {
    config: Config;
    clientStore: ClientStore;
    codeStore: CodeStore;
    userStore: UserStore;
    signingKey: SigningKey;
    now?: (() => number) | undefined; // テスト用の今の時刻を返す関数
};

export function createApp(deps: AppDeps): Express {
    const { config, clientStore, codeStore, userStore } = deps;
    const app = express();

    configureViews(app);
    app.use(securityHeaders());

    // トークンエンドポイントは、アプリのサーバーが呼ぶ物。セッション(Cookie)は、使わない
    app.use('/token', createTokenRouter(deps));

    // ここから下は、ブラウザの画面(セッションを使う)
    app.use(
        createSessionMiddleware({
            secret: config.sessionSecret,
            // https の時だけ Secure 属性を付ける(http のまま付けると、Cookie が出なくなる)
            secure: new URL(config.issuer).protocol === 'https:',
        }),
    );
    app.use(
        '/authorize',
        createAuthorizeRouter({
            clientStore,
            supportedScopes: SUPPORTED_SCOPES,
            defaultScope: config.defaultScope,
        }),
    );
    app.use('/login', createLoginRouter({ clientStore, userStore }));
    app.use(
        '/consent',
        createConsentRouter({
            clientStore,
            userStore,
            codeStore,
            codeTtlSec: config.codeTtlSec,
            now: deps.now,
        }),
    );

    app.use(notFoundHandler);
    app.use(pageErrorHandler);
    return app;
}
