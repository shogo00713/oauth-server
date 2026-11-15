import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureCsrfToken } from '../lib/csrf.js';
import { SESSION_COOKIE_NAME } from '../lib/session.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestResponse,
    type TestServer,
} from '../test-utils/http.js';
import { createPageTestApp, readSession } from '../test-utils/page-app.js';
import { createLogoutRouter } from './logout.js';

let server: TestServer;
let client: TestClient;

beforeEach(async () => {
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: CSRF トークンを作って、返す(フォームを開いたことにする)
            app.get('/__test/csrf', (req, res) => {
                res.send(ensureCsrfToken(req.session));
            });
            app.use('/logout', createLogoutRouter());
        }),
    );
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
});

// ログインして、フォームを開いて、そのトークンを返す
const loginAndOpenForm = async (who: TestClient = client) => {
    await who.get('/__test/login');
    return (await who.get('/__test/csrf')).text;
};

const logout = (token: string, who: TestClient = client) =>
    who.postForm('/logout', { _csrf: token });

// フォームの形で、そのまま送る(項目が 2 回ある、などを試すため)
const rawPost = (
    path: string,
    body: string,
    contentType = 'application/x-www-form-urlencoded',
    who: TestClient = client,
) => {
    const cookie = [...who.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    return fetch(`${server.baseUrl}${path}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': contentType,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
    });
};

// 403 のエラー画面で、ログインは、そのままであること
const expectRefused = async (response: TestResponse) => {
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.location).toBeNull();
    expect((await readSession(client)).tokens).not.toBeNull();
};

describe('LOGOUT /logout セッションを捨てる', () => {
    describe('POST /logout', () => {
        describe('ログアウトできる', () => {
            it('/ へ 303', async () => {
                const token = await loginAndOpenForm();

                const response = await logout(token);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
            });

            it('トークンも、CSRF トークンも消える。メッセージだけが入る', async () => {
                const token = await loginAndOpenForm();
                // 比べるために、ログアウトの前は、ログインしていること
                expect((await readSession(client)).tokens).not.toBeNull();

                await logout(token);
                const session = await readSession(client);

                expect(session.tokens).toBeNull();
                expect(session.csrfToken).toBeNull();
                expect(session.state).toBeNull();
                expect(session.codeVerifier).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(session.flash).not.toBe('');
            });

            it('セッション ID が変わる。新しい Cookie を 1 本だけ出す', async () => {
                const token = await loginAndOpenForm();
                const before = client.cookies.get(SESSION_COOKIE_NAME);

                const response = await logout(token);

                expect(response.headers.getSetCookie()).toHaveLength(1);
                expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(
                    before,
                );
            });

            it('古いセッション ID は、もう使えない(盗まれた Cookie でも、ログインできない)', async () => {
                const token = await loginAndOpenForm();
                const oldCookie = client.cookies.get(SESSION_COOKIE_NAME) ?? '';
                const stolen = createClient(server.baseUrl);
                stolen.cookies.set(SESSION_COOKIE_NAME, oldCookie);
                // 比べるために、ログアウトの前は、古い Cookie で、ログインできること
                expect((await readSession(stolen)).tokens).not.toBeNull();

                await logout(token);

                const after = createClient(server.baseUrl);
                after.cookies.set(SESSION_COOKIE_NAME, oldCookie);
                expect((await readSession(after)).tokens).toBeNull();
            });

            it('ログインしていない人(フォームは開いた)でも、/ へ 303', async () => {
                const token = (await client.get('/__test/csrf')).text;

                const response = await logout(token);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
            });

            it('リクエストのクエリは、見ない(飛ばし先は、いつも /)', async () => {
                const token = await loginAndOpenForm();

                const response = await client.postForm(
                    '/logout?next=https://evil.example/&redirect=//evil.example',
                    { _csrf: token },
                );

                expect(response.location).toBe('/');
            });

            it('キャッシュさせない', async () => {
                const token = await loginAndOpenForm();

                const response = await logout(token);

                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(response.headers.get('pragma')).toBe('no-cache');
            });
        });

        describe('CSRF トークンが、正しくない時(他のサイトから、勝手にログアウトさせられない)', () => {
            it('トークンが無ければ、403。ログインは、そのまま', async () => {
                await loginAndOpenForm();

                await expectRefused(await client.postForm('/logout', {}));
            });

            it.each([
                { name: '違うトークン', token: 'x'.repeat(43) },
                { name: '空のトークン', token: '' },
            ])('$name なら、403。ログインは、そのまま', async ({ token }) => {
                await loginAndOpenForm();

                await expectRefused(await logout(token));
            });

            it('トークンが 2 つあれば、403', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    '/logout',
                    `_csrf=${token}&_csrf=${token}`,
                );

                expect(response.status).toBe(403);
                expect((await readSession(client)).tokens).not.toBeNull();
            });

            it('トークンが、URL のクエリにあるだけでは、403(トークンは、本文で受け取る)', async () => {
                const token = await loginAndOpenForm();

                const response = await client.postForm(
                    `/logout?_csrf=${token}`,
                    {},
                );

                await expectRefused(response);
            });

            it('セッションを持っていない(Cookie が無い)人が、トークンだけ付けても、403', async () => {
                const token = await loginAndOpenForm();
                const stranger = createClient(server.baseUrl);

                const response = await logout(token, stranger);

                expect(response.status).toBe(403);
                expect((await readSession(client)).tokens).not.toBeNull();
            });

            it('別の人(別のセッション)のトークンでは、403', async () => {
                await loginAndOpenForm();
                const other = createClient(server.baseUrl);
                const othersToken = await loginAndOpenForm(other);

                await expectRefused(await logout(othersToken));
                expect((await readSession(other)).tokens).not.toBeNull();
            });

            it('フォームの形じゃない本文(JSON)でも、500 にならず 403', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    '/logout',
                    JSON.stringify({ _csrf: token }),
                    'application/json',
                );

                expect(response.status).toBe(403);
                expect((await readSession(client)).tokens).not.toBeNull();
            });

            it('本文が無くても、500 にならず 403', async () => {
                await loginAndOpenForm();

                const response = await rawPost('/logout', '');

                expect(response.status).toBe(403);
            });

            it('403 の画面に、送られたトークンを出さない。キャッシュもさせない', async () => {
                await loginAndOpenForm();

                const response = await client.postForm('/logout', {
                    _csrf: '<b>forged-token</b>',
                });

                expect(response.text).not.toContain('forged-token');
                expect(response.headers.get('cache-control')).toBe('no-store');
            });
        });
    });

    describe('POST 以外', () => {
        it('GET は 405。Allow は POST。ログインは、そのまま', async () => {
            await loginAndOpenForm();

            const response = await client.get('/logout');

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('POST');
            expect((await readSession(client)).tokens).not.toBeNull();
        });

        it('GET では、CSRF トークンを付けても、ログアウトしない', async () => {
            const token = await loginAndOpenForm();

            const response = await client.get(`/logout?_csrf=${token}`);

            expect(response.status).toBe(405);
            expect((await readSession(client)).tokens).not.toBeNull();
        });

        it('PUT と DELETE も 405', async () => {
            await loginAndOpenForm();
            const cookie = [...client.cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join('; ');

            for (const method of ['PUT', 'DELETE']) {
                const response = await fetch(`${server.baseUrl}/logout`, {
                    method,
                    redirect: 'manual',
                    headers: { Cookie: cookie },
                });

                expect(response.status).toBe(405);
            }
            expect((await readSession(client)).tokens).not.toBeNull();
        });
    });
});
