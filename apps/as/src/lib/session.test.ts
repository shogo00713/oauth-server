import { createHmac } from 'node:crypto';
import express from 'express';
import { describe, expect, it } from 'vitest';
import {
    createClient,
    startServer,
    type TestClient,
    type TestResponse,
} from '../test-utils/http.js';
import { createSessionMiddleware, type SessionOptions } from './session.js';

// ちょうど 32 文字(下限)
const SECRET = 's'.repeat(32);
const COOKIE_NAME = 'as_sid';

const buildApp = (options: Partial<SessionOptions> = {}) => {
    const app = express();
    // secure な Cookie を試すために、X-Forwarded-Proto を信じる
    app.set('trust proxy', true);
    app.use(
        createSessionMiddleware({ secret: SECRET, secure: false, ...options }),
    );
    app.get('/untouched', (_req, res) => {
        res.send('ok');
    });
    app.get('/login', (req, res) => {
        req.session.userId = 'user-1';
        res.send('ok');
    });
    app.get('/whoami', (req, res) => {
        res.json({ id: req.sessionID, userId: req.session.userId ?? null });
    });
    return app;
};

// サーバーを起動して、クライアントを渡して、終わったら止める
const withServer = async (
    options: Partial<SessionOptions>,
    run: (client: TestClient, baseUrl: string) => Promise<void>,
) => {
    const server = await startServer(buildApp(options));
    try {
        await run(createClient(server.baseUrl), server.baseUrl);
    } finally {
        await server.close();
    }
};

// whoami の答え
const whoami = async (client: TestClient) =>
    JSON.parse((await client.get('/whoami')).text) as {
        id: string;
        userId: string | null;
    };

// Set-Cookie の 1 本目を、「名前」「値」「属性の一覧」にばらす
const parseSetCookie = (response: TestResponse) => {
    const [line = '', ...attributes] = (
        response.headers.getSetCookie()[0] ?? ''
    )
        .split(';')
        .map((part) => part.trim());
    const separator = line.indexOf('=');
    return {
        name: line.slice(0, separator),
        value: line.slice(separator + 1),
        attributes,
    };
};

// express-session と同じ形(s:<id>.<署名>)の Cookie の値を、自分で作る
const signedCookie = (sessionId: string, secret: string) => {
    const signature = createHmac('sha256', secret)
        .update(sessionId)
        .digest('base64')
        .replace(/=+$/, '');
    return encodeURIComponent(`s:${sessionId}.${signature}`);
};

describe('SESSION ログインなどに使う、セッションの Cookie', () => {
    describe('createSessionMiddleware', () => {
        describe('設定の確認', () => {
            it('secret が 32 文字なら、作れる', () => {
                expect(() =>
                    createSessionMiddleware({ secret: SECRET, secure: false }),
                ).not.toThrow();
            });

            it('secret が 31 文字なら、RangeError', () => {
                expect(() =>
                    createSessionMiddleware({
                        secret: 's'.repeat(31),
                        secure: false,
                    }),
                ).toThrow(RangeError);
            });

            it('secret が空文字なら、RangeError', () => {
                expect(() =>
                    createSessionMiddleware({ secret: '', secure: false }),
                ).toThrow(RangeError);
            });

            it.each([undefined, null, 12345678, {}, [], true])(
                'secret が文字列じゃないなら、TypeError: %j',
                (value) => {
                    expect(() =>
                        createSessionMiddleware({
                            secret: value as unknown as string,
                            secure: false,
                        }),
                    ).toThrow(TypeError);
                },
            );

            it.each([1, 60, 1800])('maxAgeSec が %d なら、作れる', (value) => {
                expect(() =>
                    createSessionMiddleware({
                        secret: SECRET,
                        secure: false,
                        maxAgeSec: value,
                    }),
                ).not.toThrow();
            });

            it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
                'maxAgeSec が %j なら、RangeError(1 以上の整数)',
                (value) => {
                    expect(() =>
                        createSessionMiddleware({
                            secret: SECRET,
                            secure: false,
                            maxAgeSec: value,
                        }),
                    ).toThrow(RangeError);
                },
            );

            it.each(['60', null, {}, true])(
                'maxAgeSec が数値じゃないなら、TypeError: %j',
                (value) => {
                    expect(() =>
                        createSessionMiddleware({
                            secret: SECRET,
                            secure: false,
                            maxAgeSec: value as unknown as number,
                        }),
                    ).toThrow(TypeError);
                },
            );
        });

        describe('Cookie の出し方', () => {
            it('何も入れていないセッションには、Cookie を出さない', async () => {
                await withServer({}, async (client) => {
                    const untouched = await client.get('/untouched');
                    // 比べるために、何か入れた時は、出ること
                    const touched = await client.get('/login');

                    expect(untouched.headers.getSetCookie()).toEqual([]);
                    expect(touched.headers.getSetCookie()).toHaveLength(1);
                });
            });

            it('Cookie の名前は as_sid(client の Cookie とぶつからないように)', async () => {
                await withServer({}, async (client) => {
                    const response = await client.get('/login');

                    expect(parseSetCookie(response).name).toBe(COOKIE_NAME);
                });
            });

            it.each(['HttpOnly', 'SameSite=Lax', 'Path=/'])(
                '属性: %s',
                async (attribute) => {
                    await withServer({}, async (client) => {
                        const response = await client.get('/login');

                        expect(parseSetCookie(response).attributes).toContain(
                            attribute,
                        );
                    });
                },
            );

            it('Domain は付けない(サブドメインに、Cookie を渡さない)', async () => {
                await withServer({}, async (client) => {
                    const response = await client.get('/login');
                    const { attributes } = parseSetCookie(response);

                    // 比べるために、ほかの属性は付いていること
                    expect(attributes).toContain('HttpOnly');
                    expect(attributes.some((a) => /^domain=/i.test(a))).toBe(
                        false,
                    );
                });
            });

            it('secure: false なら、Secure は付かない', async () => {
                await withServer({ secure: false }, async (client) => {
                    const response = await client.get('/login', {
                        headers: { 'X-Forwarded-Proto': 'https' },
                    });
                    const { attributes } = parseSetCookie(response);

                    expect(attributes).toContain('HttpOnly');
                    expect(attributes).not.toContain('Secure');
                });
            });

            it('secure: true なら、Secure が付く(https の時)', async () => {
                await withServer({ secure: true }, async (client) => {
                    const response = await client.get('/login', {
                        headers: { 'X-Forwarded-Proto': 'https' },
                    });

                    expect(parseSetCookie(response).attributes).toContain(
                        'Secure',
                    );
                });
            });

            it('Expires は、既定で 30 分後', async () => {
                await withServer({}, async (client) => {
                    const before = Date.now();
                    const response = await client.get('/login');
                    const expires = parseSetCookie(response).attributes.find(
                        (a) => /^expires=/i.test(a),
                    );

                    const expiresAt = Date.parse(expires?.slice(8) ?? '');
                    // 秒より細かい所は、切り捨てられるので、数秒の幅を見る
                    expect(expiresAt).toBeGreaterThan(before + 1795 * 1000);
                    expect(expiresAt).toBeLessThan(Date.now() + 1805 * 1000);
                });
            });

            it('maxAgeSec を渡したら、その長さになる', async () => {
                await withServer({ maxAgeSec: 60 }, async (client) => {
                    const before = Date.now();
                    const response = await client.get('/login');
                    const expires = parseSetCookie(response).attributes.find(
                        (a) => /^expires=/i.test(a),
                    );

                    const expiresAt = Date.parse(expires?.slice(8) ?? '');
                    expect(expiresAt).toBeGreaterThan(before + 55 * 1000);
                    expect(expiresAt).toBeLessThan(Date.now() + 65 * 1000);
                });
            });
        });

        describe('セッションの保持', () => {
            it('Cookie を送れば、前に入れた内容が戻る', async () => {
                await withServer({}, async (client) => {
                    await client.get('/login');

                    expect((await whoami(client)).userId).toBe('user-1');
                });
            });

            it('Cookie が無ければ、空', async () => {
                await withServer({}, async (client) => {
                    expect((await whoami(client)).userId).toBeNull();
                });
            });

            it('別のクライアントには、見えない', async () => {
                await withServer({}, async (client, baseUrl) => {
                    await client.get('/login');
                    const other = createClient(baseUrl);

                    expect((await whoami(client)).userId).toBe('user-1');
                    expect((await whoami(other)).userId).toBeNull();
                });
            });

            it('Cookie の署名を壊したら、受け付けない(空のセッションになる)', async () => {
                await withServer({}, async (client) => {
                    await client.get('/login');
                    // 比べるために、壊す前は、見えること
                    expect((await whoami(client)).userId).toBe('user-1');

                    const value = client.cookies.get(COOKIE_NAME) ?? '';
                    // s%3A<id>.<署名> の、署名の先頭の 1 文字を変える
                    const dot = value.lastIndexOf('.');
                    const first = value[dot + 1] === 'A' ? 'B' : 'A';
                    client.cookies.set(
                        COOKIE_NAME,
                        `${value.slice(0, dot + 1)}${first}${value.slice(dot + 2)}`,
                    );

                    expect((await whoami(client)).userId).toBeNull();
                });
            });

            it('別の秘密で署名した Cookie は、受け付けない', async () => {
                await withServer({}, async (client, baseUrl) => {
                    await client.get('/login');
                    const { id } = await whoami(client);

                    const withRightSecret = createClient(baseUrl);
                    withRightSecret.cookies.set(
                        COOKIE_NAME,
                        signedCookie(id, SECRET),
                    );
                    const withWrongSecret = createClient(baseUrl);
                    withWrongSecret.cookies.set(
                        COOKIE_NAME,
                        signedCookie(id, 'x'.repeat(32)),
                    );

                    // 比べるために、正しい秘密で署名すれば、通ること(作り方が合っている証拠)
                    expect((await whoami(withRightSecret)).userId).toBe(
                        'user-1',
                    );
                    expect((await whoami(withWrongSecret)).userId).toBeNull();
                });
            });

            it('署名の無い、セッション ID だけの Cookie は、受け付けない', async () => {
                await withServer({}, async (client, baseUrl) => {
                    await client.get('/login');
                    const { id } = await whoami(client);

                    const bare = createClient(baseUrl);
                    bare.cookies.set(COOKIE_NAME, id);

                    expect((await whoami(client)).userId).toBe('user-1');
                    expect((await whoami(bare)).userId).toBeNull();
                });
            });

            it('寿命が過ぎたら、空になる', async () => {
                await withServer({ maxAgeSec: 1 }, async (client) => {
                    await client.get('/login');
                    // 比べるために、すぐなら、見えること
                    expect((await whoami(client)).userId).toBe('user-1');

                    await new Promise((resolve) => setTimeout(resolve, 1100));

                    expect((await whoami(client)).userId).toBeNull();
                });
            });
        });
    });
});
