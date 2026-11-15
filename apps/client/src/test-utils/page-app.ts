/**
 * 画面を返すルート(/、/detail/:id など)のテスト用の app(テスト専用)
 *
 * 本物と同じ部品(画面、ヘッダー、セッション、エラー画面)を組み合わせて、
 * テストしたいルートを mount で取り付ける。
 */
import express, { type Express } from 'express';
import { notFoundHandler, pageErrorHandler } from '../lib/page-errors.js';
import { securityHeaders } from '../lib/security-headers.js';
import { createSessionMiddleware } from '../lib/session.js';
import { configureViews } from '../lib/views.js';
import type { TokenSet } from '../oauth/token-request.js';
import type { TestClient } from './http.js';

// /__test/login でログインしたことにする時に、セッションに入れるトークン
export const TEST_TOKENS: TokenSet = {
    accessToken: 'test-access-token',
    expiresAt: undefined,
    scope: 'read write',
};

export function createPageTestApp(mount: (app: Express) => void): Express {
    const app = express();
    configureViews(app);
    app.use(securityHeaders());
    app.use(createSessionMiddleware({ secret: 's'.repeat(32), secure: false }));

    // テスト専用の道: ログイン済みにする
    app.get('/__test/login', (req, res) => {
        req.session.tokens = TEST_TOKENS;
        res.send('ok');
    });
    // テスト専用の道: セッションの中身を見る(見るだけで、変えない)
    app.get('/__test/session', (req, res) => {
        res.json({
            csrfToken: req.session.csrfToken ?? null,
            state: req.session.state ?? null,
            codeVerifier: req.session.codeVerifier ?? null,
            tokens: req.session.tokens ?? null,
            flash: req.session.flash ?? null,
        });
    });

    mount(app);

    app.use(notFoundHandler);
    app.use(pageErrorHandler);
    return app;
}

export type SessionState = {
    csrfToken: string | null;
    state: string | null;
    codeVerifier: string | null;
    tokens: TokenSet | null;
    flash: string | null;
};

// セッションの中身を読む(createPageTestApp の app でだけ使える)
export async function readSession(client: TestClient): Promise<SessionState> {
    return JSON.parse((await client.get('/__test/session')).text);
}
