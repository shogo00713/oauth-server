import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeCodeChallenge } from '../lib/pkce.js';
import { SESSION_COOKIE_NAME } from '../lib/session.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestResponse,
    type TestServer,
} from '../test-utils/http.js';
import { createPageTestApp, readSession } from '../test-utils/page-app.js';
import { createLoginRouter, type LoginDeps } from './login.js';

const NOW = 1_800_000_000;

const DEPS: LoginDeps = {
    clientId: 'memoboard',
    redirectUri: 'http://localhost:4001/callback',
    authorizationEndpoint: 'http://localhost:4000/authorize',
    requestedScope: 'read write',
    now: () => NOW,
};

// 43 文字の base64url(32 バイトの乱数)
const RANDOM_43 = /^[A-Za-z0-9_-]{43}$/;

let server: TestServer;
let client: TestClient;

const start = async (overrides: Partial<LoginDeps> = {}) => {
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: 期限が分からないトークンで、ログイン済みにする(/__test/login)の他に、期限つきで
            app.get('/__test/login-until/:expiresAt', (req, res) => {
                req.session.tokens = {
                    accessToken: 'at-test',
                    expiresAt: Number(req.params['expiresAt']),
                    scope: 'read write',
                };
                res.send('ok');
            });
            app.use('/login', createLoginRouter({ ...DEPS, ...overrides }));
        }),
    );
    client = createClient(server.baseUrl);
};

afterEach(async () => {
    await server.close();
});

// リダイレクト先の URL
const locationOf = (response: TestResponse): URL => {
    expect(response.location).not.toBeNull();
    return new URL(response.location ?? '');
};

describe('LOGIN /login 認可リクエストを始める RFC 6749 4.1.1 / RFC 7636', () => {
    describe('GET /login', () => {
        describe('認可エンドポイントへの、リダイレクト', () => {
            beforeEach(async () => {
                await start();
            });

            it('303 で、設定した認可エンドポイントへ飛ばす', async () => {
                const response = await client.get('/login');
                const url = locationOf(response);

                expect(response.status).toBe(303);
                expect(`${url.origin}${url.pathname}`).toBe(
                    'http://localhost:4000/authorize',
                );
            });

            it('認可リクエストの項目が、全部ある', async () => {
                const url = locationOf(await client.get('/login'));

                expect(url.searchParams.get('response_type')).toBe('code');
                expect(url.searchParams.get('client_id')).toBe('memoboard');
                expect(url.searchParams.get('redirect_uri')).toBe(
                    'http://localhost:4001/callback',
                );
                expect(url.searchParams.get('scope')).toBe('read write');
                expect(url.searchParams.get('code_challenge_method')).toBe(
                    'S256',
                );
                expect(url.searchParams.get('state')).toMatch(RANDOM_43);
                expect(url.searchParams.get('code_challenge')).toMatch(
                    RANDOM_43,
                );
            });

            it('state を、セッションに入れる。URL の state と同じ', async () => {
                const url = locationOf(await client.get('/login'));
                const session = await readSession(client);

                expect(session.state).toBe(url.searchParams.get('state'));
                expect(session.state).toMatch(RANDOM_43);
            });

            it('code_verifier を、セッションに入れる。URL の code_challenge は、その S256', async () => {
                const url = locationOf(await client.get('/login'));
                const session = await readSession(client);

                expect(session.codeVerifier).toMatch(RANDOM_43);
                expect(url.searchParams.get('code_challenge')).toBe(
                    computeCodeChallenge(session.codeVerifier ?? ''),
                );
            });

            it('code_verifier は、URL には出さない(AS へ渡すのは、code_challenge だけ)', async () => {
                const response = await client.get('/login');
                const session = await readSession(client);

                expect(response.location).not.toContain(
                    session.codeVerifier ?? 'x',
                );
            });

            it('state と code_verifier は、ログインのたびに、新しく作る', async () => {
                const other = createClient(server.baseUrl);

                const first = locationOf(await client.get('/login'));
                const second = locationOf(await other.get('/login'));
                const firstSession = await readSession(client);
                const secondSession = await readSession(other);

                expect(first.searchParams.get('state')).not.toBe(
                    second.searchParams.get('state'),
                );
                expect(first.searchParams.get('code_challenge')).not.toBe(
                    second.searchParams.get('code_challenge'),
                );
                expect(firstSession.codeVerifier).not.toBe(
                    secondSession.codeVerifier,
                );
            });

            it('同じセッションで、もう一度始めたら、新しい state に置き換わる(前の state は、使えなくなる)', async () => {
                const first = locationOf(await client.get('/login'));
                const second = locationOf(await client.get('/login'));
                const session = await readSession(client);

                expect(first.searchParams.get('state')).not.toBe(
                    second.searchParams.get('state'),
                );
                expect(session.state).toBe(second.searchParams.get('state'));
                expect(session.codeVerifier).not.toBeNull();
                expect(computeCodeChallenge(session.codeVerifier ?? '')).toBe(
                    second.searchParams.get('code_challenge'),
                );
            });

            it('セッションの Cookie を出す', async () => {
                const response = await client.get('/login');

                expect(client.cookies.has(SESSION_COOKIE_NAME)).toBe(true);
                expect(response.headers.getSetCookie()).toHaveLength(1);
            });

            it('キャッシュさせない', async () => {
                const response = await client.get('/login');

                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(response.headers.get('pragma')).toBe('no-cache');
            });
        });

        describe('設定の値を使う', () => {
            it('認可エンドポイントに元からあるクエリは、残る', async () => {
                await start({
                    authorizationEndpoint:
                        'http://localhost:4000/authorize?tenant=a',
                });

                const url = locationOf(await client.get('/login'));

                expect(url.searchParams.get('tenant')).toBe('a');
                expect(url.searchParams.get('response_type')).toBe('code');
            });

            it('スコープは、設定の物', async () => {
                await start({ requestedScope: 'read' });

                const url = locationOf(await client.get('/login'));

                expect(url.searchParams.get('scope')).toBe('read');
            });

            it('client_id と redirect_uri も、設定の物', async () => {
                await start({
                    clientId: 'other-app',
                    redirectUri: 'https://app.example.com/callback',
                });

                const url = locationOf(await client.get('/login'));

                expect(url.searchParams.get('client_id')).toBe('other-app');
                expect(url.searchParams.get('redirect_uri')).toBe(
                    'https://app.example.com/callback',
                );
            });
        });

        describe('リクエストのクエリは、見ない(オープンリダイレクトにしない)', () => {
            beforeEach(async () => {
                await start();
            });

            it('飛ばす先や、送る値を、クエリで変えられない', async () => {
                const query = new URLSearchParams({
                    redirect_uri: 'https://evil.example/cb',
                    client_id: 'evil-app',
                    scope: 'admin',
                    state: 'attacker-state',
                    code_challenge: 'attacker-challenge',
                    next: 'https://evil.example/',
                    return_to: 'https://evil.example/',
                    authorization_endpoint: 'https://evil.example/authorize',
                });

                const response = await client.get(`/login?${query}`);
                const url = locationOf(response);

                expect(`${url.origin}${url.pathname}`).toBe(
                    'http://localhost:4000/authorize',
                );
                expect(url.searchParams.get('redirect_uri')).toBe(
                    'http://localhost:4001/callback',
                );
                expect(url.searchParams.get('client_id')).toBe('memoboard');
                expect(url.searchParams.get('scope')).toBe('read write');
                expect(url.searchParams.get('state')).not.toBe(
                    'attacker-state',
                );
                expect(url.searchParams.get('code_challenge')).not.toBe(
                    'attacker-challenge',
                );
                expect(response.location).not.toContain('evil');
                expect((await readSession(client)).state).not.toBe(
                    'attacker-state',
                );
            });
        });

        describe('すでにログインしている時', () => {
            beforeEach(async () => {
                await start();
            });

            it.each([
                { name: '期限が分からないトークン', path: '/__test/login' },
                {
                    name: '期限が十分先のトークン',
                    path: `/__test/login-until/${NOW + 3600}`,
                },
            ])('$name なら、始めずに、/ へ 303', async ({ path }) => {
                await client.get(path);
                const before = await readSession(client);

                const response = await client.get('/login');
                const after = await readSession(client);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                // state も code_verifier も、作らない。トークンは、そのまま
                expect(after.state).toBeNull();
                expect(after.codeVerifier).toBeNull();
                expect(after.tokens).toEqual(before.tokens);
            });

            it.each([
                { name: '期限切れ', expiresAt: NOW - 1 },
                { name: '期限ちょうど', expiresAt: NOW },
                { name: '期限の 30 秒前(余裕の中)', expiresAt: NOW + 30 },
            ])(
                '$name のトークンなら、ログインを始める',
                async ({ expiresAt }) => {
                    await client.get(`/__test/login-until/${expiresAt}`);

                    const response = await client.get('/login');
                    const url = locationOf(response);
                    const session = await readSession(client);

                    expect(response.status).toBe(303);
                    expect(`${url.origin}${url.pathname}`).toBe(
                        'http://localhost:4000/authorize',
                    );
                    expect(session.state).toBe(url.searchParams.get('state'));
                },
            );
        });

        describe('設定が使えない時', () => {
            it('認可エンドポイントが URL じゃなければ、500 のエラー画面。セッションには、何も残さない', async () => {
                await start({ authorizationEndpoint: 'not a url' });
                const consoleError = vi
                    .spyOn(console, 'error')
                    .mockImplementation(() => {});

                try {
                    const response = await client.get('/login');
                    const session = await readSession(client);

                    expect(response.status).toBe(500);
                    expect(response.headers.get('content-type')).toMatch(
                        /^text\/html/,
                    );
                    expect(response.text).not.toContain('not a url');
                    expect(session.state).toBeNull();
                    expect(session.codeVerifier).toBeNull();
                } finally {
                    consoleError.mockRestore();
                }
            });

            it('その時は、セッションの Cookie も出さない', async () => {
                await start({ authorizationEndpoint: 'not a url' });
                const consoleError = vi
                    .spyOn(console, 'error')
                    .mockImplementation(() => {});

                try {
                    const response = await client.get('/login');

                    expect(response.headers.getSetCookie()).toEqual([]);
                } finally {
                    consoleError.mockRestore();
                }
            });
        });
    });

    describe('GET 以外', () => {
        beforeEach(async () => {
            await start();
        });

        it('POST は 405。Allow は GET。state は作らない', async () => {
            const response = await client.postForm('/login', {});
            const session = await readSession(client);

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
            expect(session.state).toBeNull();
            expect(response.headers.getSetCookie()).toEqual([]);
        });
    });
});
