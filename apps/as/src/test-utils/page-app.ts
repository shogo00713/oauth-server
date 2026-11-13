/**
 * 画面を返すルート(/authorize、/login、/consent)のテスト用の app(テスト専用)
 *
 * 本物と同じ部品(画面、ヘッダー、セッション、エラー画面)を組み合わせて、
 * テストしたいルートを mount で取り付ける。
 */
import express, { type Express } from 'express';
import type { AuthzRequest } from '../lib/authz-request.js';
import { notFoundHandler, pageErrorHandler } from '../lib/page-errors.js';
import { securityHeaders } from '../lib/security-headers.js';
import { createSessionMiddleware } from '../lib/session.js';
import { configureViews } from '../lib/views.js';
import type { TestClient } from './http.js';

// /__test/login でログインしたことにする、ユーザーの ID
export const TEST_USER_ID = 'user-1';

export function createPageTestApp(mount: (app: Express) => void): Express {
    const app = express();
    configureViews(app);
    app.use(securityHeaders());
    app.use(createSessionMiddleware({ secret: 's'.repeat(32), secure: false }));

    // テスト専用の道: ログイン済みにする
    app.get('/__test/login', (req, res) => {
        req.session.userId = TEST_USER_ID;
        res.send('ok');
    });
    // テスト専用の道: セッションの中身を見る(見るだけで、変えない)
    app.get('/__test/session', (req, res) => {
        res.json({
            userId: req.session.userId ?? null,
            pending: req.session.pending ?? null,
            csrfToken: req.session.csrfToken ?? null,
        });
    });

    mount(app);

    app.use(notFoundHandler);
    app.use(pageErrorHandler);
    return app;
}

export type SessionState = {
    userId: string | null;
    pending: AuthzRequest | null;
    csrfToken: string | null;
};

// セッションの中身を読む(createPageTestApp の app でだけ使える)
export async function readSession(client: TestClient): Promise<SessionState> {
    return JSON.parse((await client.get('/__test/session')).text);
}
