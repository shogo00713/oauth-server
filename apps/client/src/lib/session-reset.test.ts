import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createClient,
    startServer,
    type TestClient,
    type TestServer,
} from '../test-utils/http.js';
import { createPageTestApp, readSession } from '../test-utils/page-app.js';
import { SESSION_COOKIE_NAME } from './session.js';
import { resetSession } from './session-reset.js';

let server: TestServer;
let client: TestClient;

beforeEach(async () => {
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: セッションに、いろいろ入れる
            app.get('/__seed', (req, res) => {
                req.session.tokens = {
                    accessToken: 'at-seeded',
                    expiresAt: undefined,
                    scope: 'read write',
                };
                req.session.csrfToken = 'csrf-seeded';
                req.session.state = 'state-seeded';
                req.session.codeVerifier = 'verifier-seeded';
                req.session.flash = 'flash-seeded';
                res.send('ok');
            });
            app.get('/__reset', async (req, res) => {
                await resetSession(req);
                res.send('reset');
            });
            app.get('/__reset-flash', async (req, res) => {
                await resetSession(req, 'さようなら');
                res.send('reset');
            });
        }),
    );
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
});

describe('SESSION RESET セッションを捨てて、新しくする', () => {
    describe('resetSession', () => {
        it('セッション ID が変わる', async () => {
            await client.get('/__seed');
            const before = client.cookies.get(SESSION_COOKIE_NAME);

            await client.get('/__reset');
            const after = client.cookies.get(SESSION_COOKIE_NAME);

            expect(before).toBeDefined();
            expect(after).toBeDefined();
            expect(after).not.toBe(before);
        });

        it('新しい Cookie を 1 本だけ出す', async () => {
            await client.get('/__seed');

            const response = await client.get('/__reset');

            expect(response.status).toBe(200);
            expect(response.headers.getSetCookie()).toHaveLength(1);
        });

        it('中身は、全部消える(トークン、CSRF トークン、state、code_verifier、メッセージ)', async () => {
            await client.get('/__seed');
            // 比べるために、捨てる前は、入っていること
            expect((await readSession(client)).tokens).not.toBeNull();

            await client.get('/__reset');
            const session = await readSession(client);

            expect(session).toEqual({
                csrfToken: null,
                state: null,
                codeVerifier: null,
                tokens: null,
                flash: null,
            });
        });

        it('古いセッション ID は、もう使えない(ストアから消える)', async () => {
            await client.get('/__seed');
            const oldCookie = client.cookies.get(SESSION_COOKIE_NAME) ?? '';
            const old = createClient(server.baseUrl);
            old.cookies.set(SESSION_COOKIE_NAME, oldCookie);
            // 比べるために、捨てる前は、古い Cookie で、中身が見えること
            expect((await readSession(old)).tokens).not.toBeNull();

            await client.get('/__reset');

            const afterReset = createClient(server.baseUrl);
            afterReset.cookies.set(SESSION_COOKIE_NAME, oldCookie);
            const session = await readSession(afterReset);
            expect(session.tokens).toBeNull();
            expect(session.flash).toBeNull();
        });

        it('flash を渡せば、新しいセッションに入る', async () => {
            await client.get('/__seed');

            await client.get('/__reset-flash');

            expect((await readSession(client)).flash).toBe('さようなら');
        });

        it('flash を渡さなければ、メッセージは入らない(前のメッセージも、引き継がない)', async () => {
            await client.get('/__seed');

            await client.get('/__reset');

            expect((await readSession(client)).flash).toBeNull();
        });

        it('flash を渡しても、ほかの中身は、引き継がない', async () => {
            await client.get('/__seed');

            await client.get('/__reset-flash');
            const session = await readSession(client);

            expect(session.tokens).toBeNull();
            expect(session.csrfToken).toBeNull();
            expect(session.state).toBeNull();
            expect(session.codeVerifier).toBeNull();
        });

        it('セッションを持っていない人にも、使える(エラーにならない)', async () => {
            const response = await client.get('/__reset-flash');

            expect(response.status).toBe(200);
            expect((await readSession(client)).flash).toBe('さようなら');
        });
    });
});
