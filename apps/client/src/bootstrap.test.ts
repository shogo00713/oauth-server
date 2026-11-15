import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from './bootstrap.js';
import {
    FAKE_ACCESS_TOKEN,
    startFakeBackends,
    type FakeBackends,
} from './test-utils/fake-backends.js';
import { createClient, startServer } from './test-utils/http.js';

const CLIENT_SECRET = 'client-secret-for-test-0123456789abcdef';
const SESSION_SECRET = 'session-secret-for-test-0123456789abcdef';

let backends: FakeBackends;

beforeEach(async () => {
    backends = await startFakeBackends();
});

afterEach(async () => {
    await backends.close();
});

const env = (
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
    BASE_URL: 'http://localhost:4001',
    PORT: '4001',
    AS_BASE_URL: backends.asBaseUrl,
    RS_BASE_URL: backends.rsBaseUrl,
    CLIENT_SECRET,
    SESSION_SECRET,
    ...overrides,
});

// express-session と同じ形(s:<id>.<署名>)の Cookie の値を、自分で作る
const signedCookie = (sessionId: string, secret: string) => {
    const signature = createHmac('sha256', secret)
        .update(sessionId)
        .digest('base64')
        .replace(/=+$/, '');
    return encodeURIComponent(`s:${sessionId}.${signature}`);
};

// bootstrap が、同期でも、async でも、同じように扱えるようにする
const boot = async (environment: Record<string, string | undefined>) =>
    bootstrap(environment);

// 認可リクエストを始めて、AS から戻ってきたことにする
const login = async (browser: ReturnType<typeof createClient>) => {
    const started = await browser.get('/login');
    const authorize = new URL(started.location ?? '');
    const state = authorize.searchParams.get('state') ?? '';
    const callback = await browser.get(
        `/callback?${new URLSearchParams({ code: 'code-1', state })}`,
    );
    return { authorize, callback };
};

describe('BOOTSTRAP 起動の組み立て', () => {
    describe('bootstrap', () => {
        describe('起動できる例', () => {
            it('環境変数から、動く app ができて、最初から最後まで通る(AS_BASE_URL の /token で引き換えて、RS_BASE_URL の /memos を呼ぶ)', async () => {
                backends.memos.push({
                    id: 's1',
                    body: '牛乳を買う',
                    createdAt: '2026-10-01T00:00:00.000Z',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                });
                const { app } = await boot(env());
                const server = await startServer(app);

                try {
                    const browser = createClient(server.baseUrl);
                    const { callback } = await login(browser);
                    const list = await browser.get('/');

                    expect(callback.status).toBe(303);
                    expect(backends.tokenRequests).toHaveLength(1);
                    expect(list.status).toBe(200);
                    expect(list.text).toContain('牛乳を買う');
                    expect(
                        backends.rsRequests.at(-1)?.headers.authorization,
                    ).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`);
                } finally {
                    await server.close();
                }
            });

            it('config は、環境変数から作った物が返る(URL は、そこから作る)', async () => {
                const { config } = await boot(env({ PORT: '4321' }));

                expect(config).toMatchObject({
                    baseUrl: 'http://localhost:4001',
                    port: 4321,
                    asBaseUrl: backends.asBaseUrl,
                    rsBaseUrl: backends.rsBaseUrl,
                    clientId: 'memoboard',
                    clientSecret: CLIENT_SECRET,
                    sessionSecret: SESSION_SECRET,
                    requestedScope: 'read write',
                    redirectUri: 'http://localhost:4001/callback',
                    authorizationEndpoint: `${backends.asBaseUrl}/authorize`,
                    tokenEndpoint: `${backends.asBaseUrl}/token`,
                });
            });

            it('省略した CLIENT_ID と REQUESTED_SCOPE は、既定値(memoboard、read write)で動く', async () => {
                const { app } = await boot(env());
                const server = await startServer(app);

                try {
                    const { authorize } = await login(
                        createClient(server.baseUrl),
                    );

                    expect(authorize.searchParams.get('client_id')).toBe(
                        'memoboard',
                    );
                    expect(authorize.searchParams.get('scope')).toBe(
                        'read write',
                    );
                    const basic = Buffer.from(
                        `memoboard:${CLIENT_SECRET}`,
                    ).toString('base64');
                    expect(
                        backends.tokenRequests[0]?.headers.authorization,
                    ).toBe(`Basic ${basic}`);
                } finally {
                    await server.close();
                }
            });

            it('CLIENT_ID と REQUESTED_SCOPE を指定したら、その値で動く', async () => {
                const { app } = await boot(
                    env({ CLIENT_ID: 'my-board', REQUESTED_SCOPE: 'read' }),
                );
                const server = await startServer(app);

                try {
                    const { authorize } = await login(
                        createClient(server.baseUrl),
                    );

                    expect(authorize.searchParams.get('client_id')).toBe(
                        'my-board',
                    );
                    expect(authorize.searchParams.get('scope')).toBe('read');
                    const basic = Buffer.from(
                        `my-board:${CLIENT_SECRET}`,
                    ).toString('base64');
                    expect(
                        backends.tokenRequests[0]?.headers.authorization,
                    ).toBe(`Basic ${basic}`);
                } finally {
                    await server.close();
                }
            });

            it('SESSION_SECRET は、Cookie の署名に使う(別の秘密で署名した Cookie は、受け付けない)', async () => {
                backends.memos.push({
                    id: 's1',
                    body: '見えるはずのメモ',
                    createdAt: '2026-10-01T00:00:00.000Z',
                    updatedAt: '2026-10-01T00:00:00.000Z',
                });
                const { app } = await boot(env());
                const server = await startServer(app);

                try {
                    const owner = createClient(server.baseUrl);
                    await login(owner);
                    const cookieValue = decodeURIComponent(
                        owner.cookies.get('memoboard_sid') ?? '',
                    );
                    // s:<セッション ID>.<署名>
                    const sessionId = cookieValue.slice(
                        2,
                        cookieValue.lastIndexOf('.'),
                    );

                    const withRightSecret = createClient(server.baseUrl);
                    withRightSecret.cookies.set(
                        'memoboard_sid',
                        signedCookie(sessionId, SESSION_SECRET),
                    );
                    const withWrongSecret = createClient(server.baseUrl);
                    withWrongSecret.cookies.set(
                        'memoboard_sid',
                        signedCookie(sessionId, 'x'.repeat(40)),
                    );

                    expect((await withRightSecret.get('/')).text).toContain(
                        '見えるはずのメモ',
                    );
                    expect((await withWrongSecret.get('/')).text).toContain(
                        'href="/login"',
                    );
                } finally {
                    await server.close();
                }
            });

            it('BASE_URL が https なら、Secure 付きの Cookie を要求する(http のまま来ると、Cookie が出ない)', async () => {
                const { app } = await boot(
                    env({ BASE_URL: 'https://board.example.com' }),
                );
                const server = await startServer(app);

                try {
                    const response = await createClient(server.baseUrl).get(
                        '/login',
                    );

                    expect(response.status).toBe(303);
                    expect(response.headers.getSetCookie()).toEqual([]);
                } finally {
                    await server.close();
                }
            });

            it('呼ぶたびに、別々の app ができる(セッションは、混ざらない)', async () => {
                const first = await boot(env());
                const second = await boot(env());
                const serverA = await startServer(first.app);
                const serverB = await startServer(second.app);

                try {
                    const browser = createClient(serverA.baseUrl);
                    await login(browser);
                    const other = createClient(serverB.baseUrl);
                    other.cookies.set(
                        'memoboard_sid',
                        browser.cookies.get('memoboard_sid') ?? '',
                    );

                    expect((await browser.get('/')).status).toBe(200);
                    expect((await other.get('/')).text).toContain(
                        'href="/login"',
                    );
                } finally {
                    await serverA.close();
                    await serverB.close();
                }
            });
        });

        describe('起動できない例(例外)', () => {
            it.each([
                'BASE_URL',
                'PORT',
                'AS_BASE_URL',
                'RS_BASE_URL',
                'CLIENT_SECRET',
                'SESSION_SECRET',
            ])('%s が無ければ、名前がメッセージに入る', async (name) => {
                const environment = env();
                delete environment[name];

                await expect(boot(environment)).rejects.toThrow(name);
            });

            it('環境変数が不正なら、その名前が、メッセージに入る(BASE_URL にパス)', async () => {
                await expect(
                    boot(env({ BASE_URL: 'http://localhost:4001/app' })),
                ).rejects.toThrow('BASE_URL');
            });

            it('秘密が短すぎる時、秘密の値は、メッセージに入らない', async () => {
                const error = await boot(
                    env({
                        CLIENT_SECRET: 'short-client-secret',
                        SESSION_SECRET: 'short-session-secret',
                    }),
                ).then(
                    () => undefined,
                    (reason: unknown) => reason,
                );

                expect(error).toBeInstanceOf(Error);
                const message = (error as Error).message;
                expect(message).toContain('CLIENT_SECRET');
                expect(message).toContain('SESSION_SECRET');
                expect(message).not.toContain('short-client-secret');
                expect(message).not.toContain('short-session-secret');
            });

            it('SESSION_SECRET と CLIENT_SECRET の、両方が不正なら、両方の名前が入る', async () => {
                await expect(
                    boot(
                        env({
                            CLIENT_SECRET: undefined,
                            SESSION_SECRET: undefined,
                        }),
                    ),
                ).rejects.toThrow(
                    /CLIENT_SECRET[\s\S]*SESSION_SECRET|SESSION_SECRET[\s\S]*CLIENT_SECRET/,
                );
            });
        });
    });
});
