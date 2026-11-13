import express, {
    type NextFunction,
    type Request,
    type Response,
} from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type TestServer } from '../test-utils/http.js';
import {
    createTestKeyPair,
    signToken,
    TEST_AUDIENCE,
    TEST_ISSUER,
    TEST_NOW,
} from '../test-utils/tokens.js';
import { authenticate } from './authenticate.js';
import { requireScope } from './require-scope.js';

const REALM = 'simple-memo';
const INSUFFICIENT_DESCRIPTION =
    'The request requires higher privileges than provided by the access token';
const challenge = (scope: string) =>
    `Bearer realm="simple-memo", scope="${scope}", error="insufficient_scope", error_description="${INSUFFICIENT_DESCRIPTION}"`;

const keys = createTestKeyPair();

const handler = vi.fn((_req: Request, res: Response) => {
    res.json({ ok: true });
});
const errorSpy = vi.fn();

// authenticate を使わずに、req.auth を、ヘッダー(x-test-scope)の通りに作る(この部品だけを試すため)
const fakeAuth = (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers['x-test-scope'];
    if (typeof header === 'string')
        req.auth = {
            sub: 'user-1',
            clientId: 'memoboard',
            scope: JSON.parse(header) as string[],
        };
    next();
};

const errorHandler = (
    error: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction,
) => {
    errorSpy(error);
    res.status(500).json({ error: 'server_error' });
};

function createTestApp() {
    const app = express();

    // requireScope だけを試す道(req.auth は、ヘッダーから作る)
    app.get('/read', fakeAuth, requireScope(REALM, ['read', 'write']), handler);
    app.post('/write', fakeAuth, requireScope(REALM, ['write']), handler);
    // authenticate を通っていない道(コードの間違いを、わざと作る)
    app.get('/no-auth', requireScope(REALM, ['read']), handler);

    // authenticate と、本物のつなぎ
    const authenticateOptions = {
        publicKey: keys.publicKey,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
        realm: REALM,
        now: () => TEST_NOW + 10,
    };
    app.get(
        '/memos',
        authenticate(authenticateOptions),
        requireScope(REALM, ['read', 'write']),
        handler,
    );
    app.post(
        '/memos',
        authenticate(authenticateOptions),
        requireScope(REALM, ['write']),
        handler,
    );

    app.use(errorHandler);
    return app;
}

let server: TestServer;

beforeEach(async () => {
    handler.mockClear();
    errorSpy.mockClear();
    server = await startServer(createTestApp());
});

afterEach(async () => {
    await server.close();
});

const call = async (
    path: string,
    init: { method?: string; scope?: string[]; token?: string } = {},
) => {
    const response = await fetch(`${server.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers: {
            ...(init.scope === undefined
                ? {}
                : { 'x-test-scope': JSON.stringify(init.scope) }),
            ...(init.token === undefined
                ? {}
                : { Authorization: `Bearer ${init.token}` }),
        },
    });
    return {
        status: response.status,
        headers: response.headers,
        json: (await response.json()) as Record<string, unknown>,
    };
};

const tokenWith = (scope: string) =>
    signToken(keys.privateKey, { claims: { scope } });

describe('REQUIRE-SCOPE 認可のミドルウェア RFC 6750 3.1', () => {
    describe('requireScope(realm, accepted)', () => {
        describe('スコープが足りている', () => {
            it.each([
                {
                    name: 'GET: read',
                    path: '/read',
                    method: 'GET',
                    scope: ['read'],
                },
                {
                    name: 'GET: write(write は read を含む)',
                    path: '/read',
                    method: 'GET',
                    scope: ['write'],
                },
                {
                    name: 'GET: 両方',
                    path: '/read',
                    method: 'GET',
                    scope: ['read', 'write'],
                },
                {
                    name: 'POST: write',
                    path: '/write',
                    method: 'POST',
                    scope: ['write'],
                },
                {
                    name: 'POST: 両方',
                    path: '/write',
                    method: 'POST',
                    scope: ['read', 'write'],
                },
                {
                    name: '余計なスコープを持っていても良い',
                    path: '/write',
                    method: 'POST',
                    scope: ['admin', 'write'],
                },
            ])('$name: 次の処理に進む', async ({ path, method, scope }) => {
                const result = await call(path, { method, scope });

                expect(result.status).toBe(200);
                expect(handler).toHaveBeenCalledTimes(1);
            });
        });

        describe('スコープが足りない(403 insufficient_scope)', () => {
            it('write が要る道に、read だけ: 足りないスコープ(write)を、scope で伝える', async () => {
                const result = await call('/write', {
                    method: 'POST',
                    scope: ['read'],
                });

                expect(result.status).toBe(403);
                expect(result.headers.get('www-authenticate')).toBe(
                    challenge('write'),
                );
                expect(result.json).toEqual({
                    error: 'insufficient_scope',
                    error_description: INSUFFICIENT_DESCRIPTION,
                });
                expect(handler).not.toHaveBeenCalled();
            });

            it('scope には、受け付ける物の先頭(弱い方)だけを入れる', async () => {
                const result = await call('/read', { scope: ['admin'] });

                expect(result.status).toBe(403);
                expect(result.headers.get('www-authenticate')).toBe(
                    challenge('read'),
                );
            });

            it.each([
                { name: '空のスコープ', scope: [] as string[] },
                { name: '大文字小文字が違う', scope: ['READ'] },
                { name: '前方一致', scope: ['rea'] },
            ])('$name: 403', async ({ scope }) => {
                const result = await call('/read', { scope });

                expect(result.status).toBe(403);
                expect(handler).not.toHaveBeenCalled();
            });

            it('返事は、JSON', async () => {
                const result = await call('/read', { scope: ['admin'] });

                expect(result.headers.get('content-type')).toMatch(
                    /^application\/json/,
                );
            });
        });

        describe('authenticate を通っていない(コードの間違い)', () => {
            it('通さずに、エラー処理に渡す(500)。403 でも 200 でもない', async () => {
                const result = await call('/no-auth');

                expect(result.status).toBe(500);
                expect(errorSpy).toHaveBeenCalledTimes(1);
                expect(handler).not.toHaveBeenCalled();
            });
        });

        describe('設定が不正なら、作る時に RangeError', () => {
            it('受け付けるスコープが、空の配列', () => {
                expect(() => requireScope(REALM, [])).toThrow(RangeError);
            });

            it.each([
                { name: 'realm が空', realm: '', accepted: ['read'] },
                {
                    name: 'realm に " が入っている',
                    realm: 'a"b',
                    accepted: ['read'],
                },
                {
                    name: '先頭のスコープに空白が入っている',
                    realm: REALM,
                    accepted: ['re ad'],
                },
                { name: '先頭のスコープが空', realm: REALM, accepted: [''] },
            ])('$name', ({ realm, accepted }) => {
                expect(() => requireScope(realm, accepted)).toThrow(RangeError);
            });
        });
    });

    describe('authenticate とつないだ時(認証が先、認可が後)', () => {
        it('read のトークンで、GET は通る', async () => {
            const result = await call('/memos', { token: tokenWith('read') });

            expect(result.status).toBe(200);
        });

        it('read のトークンで、POST は 403(足りないスコープは write)', async () => {
            const result = await call('/memos', {
                method: 'POST',
                token: tokenWith('read'),
            });

            expect(result.status).toBe(403);
            expect(result.headers.get('www-authenticate')).toBe(
                challenge('write'),
            );
        });

        it('write のトークンで、GET も POST も通る', async () => {
            const token = tokenWith('write');

            const get = await call('/memos', { token });
            const post = await call('/memos', { method: 'POST', token });

            expect(get.status).toBe(200);
            expect(post.status).toBe(200);
        });

        it('トークンが無ければ、403 ではなく、401', async () => {
            const result = await call('/memos', { method: 'POST' });

            expect(result.status).toBe(401);
            expect(result.headers.get('www-authenticate')).toBe(
                'Bearer realm="simple-memo"',
            );
        });

        it('トークンが正しくなければ、403 ではなく、401(スコープの話は、認証の後)', async () => {
            const result = await call('/memos', {
                method: 'POST',
                token: signToken(keys.privateKey, {
                    claims: { scope: 'read', exp: TEST_NOW + 1 },
                }),
            });

            expect(result.status).toBe(401);
            expect(handler).not.toHaveBeenCalled();
        });
    });
});
