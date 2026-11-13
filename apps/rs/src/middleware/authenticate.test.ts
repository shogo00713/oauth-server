import { createSecretKey } from 'node:crypto';
import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type TestServer } from '../test-utils/http.js';
import {
    createTestKeyPair,
    hs256Token,
    signToken,
    TEST_AUDIENCE,
    TEST_ISSUER,
    TEST_NOW,
    unsignedToken,
    type Parts,
} from '../test-utils/tokens.js';
import { authenticate, type AuthenticateOptions } from './authenticate.js';

const REALM = 'simple-memo';
const CHALLENGE_NONE = 'Bearer realm="simple-memo"';
const CHALLENGE_MALFORMED =
    'Bearer realm="simple-memo", error="invalid_request", error_description="The Authorization header is malformed"';
const CHALLENGE_EXPIRED =
    'Bearer realm="simple-memo", error="invalid_token", error_description="The access token expired"';
const CHALLENGE_INVALID =
    'Bearer realm="simple-memo", error="invalid_token", error_description="The access token is invalid"';

const keys = createTestKeyPair();
const attacker = createTestKeyPair();

// テストの中の時計(秒)。トークンを発行した 10 秒後から始める
const clock = { now: TEST_NOW + 10 };

const options = (
    overrides: Partial<AuthenticateOptions> = {},
): AuthenticateOptions => ({
    publicKey: keys.publicKey,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    realm: REALM,
    now: () => clock.now,
    ...overrides,
});

// 認証を通った後に動く、ルートの本体(呼ばれたかどうかを数える)
const handler = vi.fn((req: Request, res: Response) => {
    res.json({ auth: req.auth ?? null });
});

// 例外が来た時の、後始末(本物は error-handler.ts。ここでは、この部品だけを試すので、自前で置く)
const errorSpy = vi.fn();

function createTestApp(overrides: Partial<AuthenticateOptions> = {}) {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.get('/protected', authenticate(options(overrides)), handler);
    app.post('/protected', authenticate(options(overrides)), handler);
    app.use(
        (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
            errorSpy(error);
            res.status(500).json({ error: 'server_error' });
        },
    );
    return app;
}

let server: TestServer;

beforeEach(async () => {
    clock.now = TEST_NOW + 10;
    handler.mockClear();
    errorSpy.mockClear();
    server = await startServer(createTestApp());
});

afterEach(async () => {
    await server.close();
});

const signed = (claims: Parts = {}, header: Parts = {}) =>
    signToken(keys.privateKey, { claims, header });

type Result = {
    status: number;
    headers: Headers;
    json: Record<string, unknown>;
    text: string;
};

// リクエストを送る(authorization を渡すと、Authorization ヘッダーを、そのまま付ける)
async function call(
    path = '/protected',
    init: {
        method?: string;
        authorization?: string | undefined;
        headers?: Record<string, string>;
        body?: string;
    } = {},
): Promise<Result> {
    const response = await fetch(`${server.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
            ...(init.authorization === undefined
                ? {}
                : { Authorization: init.authorization }),
            ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: init.body }),
    });
    const text = await response.text();
    return {
        status: response.status,
        headers: response.headers,
        json: JSON.parse(text) as Record<string, unknown>,
        text,
    };
}

const withToken = (token: string, init: { method?: string } = {}) =>
    call('/protected', { ...init, authorization: `Bearer ${token}` });

describe('AUTHENTICATE 認証のミドルウェア RFC 6750 / RFC 9068 4', () => {
    describe('認証に成功したとき', () => {
        it('次の処理に進んで、req.auth に、sub、clientId、scope が入る', async () => {
            const result = await withToken(signed({ scope: 'write read' }));

            expect(result.status).toBe(200);
            expect(result.json).toEqual({
                auth: {
                    sub: 'user-1',
                    clientId: 'memoboard',
                    scope: ['read', 'write'],
                },
            });
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('WWW-Authenticate は、付かない', async () => {
            const result = await withToken(signed());

            expect(result.headers.has('www-authenticate')).toBe(false);
        });

        it('方式の名前(Bearer)は、小文字でも良い', async () => {
            const result = await call('/protected', {
                authorization: `bearer ${signed()}`,
            });

            expect(result.status).toBe(200);
        });

        it('POST でも、同じように働く', async () => {
            const result = await withToken(signed(), { method: 'POST' });

            expect(result.status).toBe(200);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('同時に来た、別々のトークンの中身が、混ざらない', async () => {
            const [a, b] = await Promise.all([
                withToken(signed({ sub: 'alice' })),
                withToken(signed({ sub: 'bob' })),
            ]);

            expect(a.json).toMatchObject({ auth: { sub: 'alice' } });
            expect(b.json).toMatchObject({ auth: { sub: 'bob' } });
        });
    });

    describe('今の時刻(now)と、時計のずれ', () => {
        it('now は、リクエストのたびに呼ばれる(時計が進めば、同じトークンが、期限切れになる)', async () => {
            const token = signed({ exp: TEST_NOW + 100 });

            clock.now = TEST_NOW + 99;
            const before = await withToken(token);
            clock.now = TEST_NOW + 100;
            const after = await withToken(token);

            expect(before.status).toBe(200);
            expect(after.status).toBe(401);
            expect(after.headers.get('www-authenticate')).toBe(
                CHALLENGE_EXPIRED,
            );
        });

        it('clockToleranceSec を渡すと、その秒数だけ、期限切れを待つ', async () => {
            await server.close();
            server = await startServer(
                createTestApp({ clockToleranceSec: 30 }),
            );
            const token = signed({ exp: TEST_NOW + 100 });

            clock.now = TEST_NOW + 129;
            const within = await withToken(token);
            clock.now = TEST_NOW + 130;
            const beyond = await withToken(token);

            expect(within.status).toBe(200);
            expect(beyond.status).toBe(401);
        });

        it('now を渡さなければ、本物の時計を使う', async () => {
            await server.close();
            server = await startServer(createTestApp({ now: undefined }));
            const realNow = Math.floor(Date.now() / 1000);

            const valid = await withToken(
                signed({ iat: realNow, exp: realNow + 600 }),
            );
            const expired = await withToken(
                signed({ iat: realNow - 600, exp: realNow - 1 }),
            );

            expect(valid.status).toBe(200);
            expect(expired.status).toBe(401);
        });
    });

    describe('認証情報が無い(RFC 6750 3: error は付けない)', () => {
        it.each([
            { name: 'Authorization ヘッダーが無い', authorization: undefined },
            { name: 'Basic 認証', authorization: 'Basic dXNlcjpwYXNz' },
            { name: 'Digest 認証', authorization: 'Digest username="a"' },
            { name: '知らない方式', authorization: 'Token abc' },
        ])('$name: 401', async ({ authorization }) => {
            const result = await call('/protected', { authorization });

            expect(result.status).toBe(401);
            expect(result.headers.get('www-authenticate')).toBe(CHALLENGE_NONE);
            expect(result.json).toEqual({
                error: 'unauthorized',
                error_description: 'Authentication is required',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it('返事は、JSON', async () => {
            const result = await call('/protected');

            expect(result.headers.get('content-type')).toMatch(
                /^application\/json/,
            );
        });

        it('正しいトークンでも、URL のクエリ(access_token)に入れたら、受け付けない', async () => {
            const result = await call(`/protected?access_token=${signed()}`);

            expect(result.status).toBe(401);
            expect(result.headers.get('www-authenticate')).toBe(CHALLENGE_NONE);
            expect(handler).not.toHaveBeenCalled();
        });

        it('正しいトークンでも、フォームの本文(access_token)に入れたら、受け付けない', async () => {
            const result = await call('/protected', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: `access_token=${signed()}`,
            });

            expect(result.status).toBe(401);
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('Bearer なのに、形がおかしい(400 invalid_request)', () => {
        it.each([
            { name: 'トークンが無い', authorization: 'Bearer' },
            { name: 'トークンが 2 つ', authorization: 'Bearer abc def' },
            { name: '使えない文字', authorization: 'Bearer "abc"' },
        ])('$name', async ({ authorization }) => {
            const result = await call('/protected', { authorization });

            expect(result.status).toBe(400);
            expect(result.headers.get('www-authenticate')).toBe(
                CHALLENGE_MALFORMED,
            );
            expect(result.json).toEqual({
                error: 'invalid_request',
                error_description: 'The Authorization header is malformed',
            });
            expect(handler).not.toHaveBeenCalled();
        });
    });

    describe('トークンが正しくない(401 invalid_token)', () => {
        it('期限切れは、説明で、そう伝える', async () => {
            clock.now = TEST_NOW + 10_000;

            const result = await withToken(signed());

            expect(result.status).toBe(401);
            expect(result.headers.get('www-authenticate')).toBe(
                CHALLENGE_EXPIRED,
            );
            expect(result.json).toEqual({
                error: 'invalid_token',
                error_description: 'The access token expired',
            });
            expect(handler).not.toHaveBeenCalled();
        });

        it.each([
            {
                name: '別の鍵で署名',
                make: () => signToken(attacker.privateKey),
            },
            {
                name: 'alg が none',
                make: () => unsignedToken({ header: { alg: 'none' } }),
            },
            {
                name: 'HS256 の取り違え',
                make: () => hs256Token(keys.publicPem),
            },
            { name: 'typ が JWT', make: () => signed({}, { typ: 'JWT' }) },
            { name: '別の発行者', make: () => signed({ iss: 'http://evil' }) },
            { name: '別の API 宛て', make: () => signed({ aud: 'other-api' }) },
            { name: 'sub が無い', make: () => signed({ sub: undefined }) },
            { name: 'scope が壊れている', make: () => signed({ scope: ' ' }) },
            {
                name: 'まだ使えない(nbf)',
                make: () => signed({ nbf: TEST_NOW + 999 }),
            },
            { name: 'JWT ではない文字列', make: () => 'abc' },
            { name: '3 つに分かれているが、中身が出鱈目', make: () => 'a.b.c' },
        ])(
            '$name: 理由は教えずに、同じ返事(The access token is invalid)',
            async ({ make }) => {
                const result = await withToken(make());

                expect(result.status).toBe(401);
                expect(result.headers.get('www-authenticate')).toBe(
                    CHALLENGE_INVALID,
                );
                expect(result.json).toEqual({
                    error: 'invalid_token',
                    error_description: 'The access token is invalid',
                });
                expect(handler).not.toHaveBeenCalled();
            },
        );

        it('返事に、トークンや、内部の理由の名前は、入らない', async () => {
            const token = signToken(attacker.privateKey);

            const result = await withToken(token);

            const everything = `${result.text}\n${result.headers.get('www-authenticate')}`;
            expect(everything).not.toContain(token);
            expect(everything).not.toContain('bad_signature');
            expect(everything).not.toContain('InvalidTokenError');
        });
    });

    describe('設定', () => {
        it('realm は、WWW-Authenticate に入る', async () => {
            await server.close();
            server = await startServer(createTestApp({ realm: 'my-api' }));

            const result = await call('/protected');

            expect(result.headers.get('www-authenticate')).toBe(
                'Bearer realm="my-api"',
            );
        });

        it.each([
            { name: 'realm が空', overrides: { realm: '' } },
            { name: 'realm に " が入っている', overrides: { realm: 'a"b' } },
            { name: 'realm に改行', overrides: { realm: 'a\r\nb' } },
            { name: 'issuer が空', overrides: { issuer: '' } },
            { name: 'audience が空', overrides: { audience: '' } },
        ])(
            '設定が不正なら、リクエストを待たずに、作る時に RangeError: $name',
            ({ overrides }) => {
                expect(() => authenticate(options(overrides))).toThrow(
                    RangeError,
                );
            },
        );
    });

    describe('トークンのせいじゃない失敗(設定の間違いなど)', () => {
        it('401 にはならず、エラー処理に渡って、500 になる', async () => {
            const consoleError = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {});
            await server.close();
            server = await startServer(
                createTestApp({
                    publicKey: createSecretKey(Buffer.from('x'.repeat(32))),
                }),
            );

            const result = await withToken(signed());

            expect(result.status).toBe(500);
            expect(result.headers.has('www-authenticate')).toBe(false);
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(handler).not.toHaveBeenCalled();
            consoleError.mockRestore();
        });
    });
});
