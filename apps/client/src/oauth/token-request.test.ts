import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    sendJson,
    startStubServer,
    type StubHandler,
    type StubServer,
} from '../test-utils/stub-server.js';
import {
    exchangeCode,
    type TokenExchangeInput,
    type TokenExchangeResult,
} from './token-request.js';

const CLIENT_SECRET = 'my-secret-value-for-testing';
const CODE = 'code-abc123';
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
// JWT のような、ドットで区切った形(1 つの文字列として書かない)
const ACCESS_TOKEN = ['header-part', 'payload-part', 'signature_part'].join(
    '.',
);

const okBody = () => ({
    access_token: ACCESS_TOKEN,
    token_type: 'Bearer',
    expires_in: 600,
    scope: 'read write',
});

let respond: StubHandler;
let server: StubServer;

beforeEach(async () => {
    respond = (_request, response) => sendJson(response, 200, okBody());
    server = await startStubServer((request, response) =>
        respond(request, response),
    );
});

afterEach(async () => {
    await server.close();
});

const input = (
    overrides: Partial<TokenExchangeInput> = {},
): TokenExchangeInput => ({
    tokenEndpoint: `${server.baseUrl}/token`,
    clientId: 'memoboard',
    clientSecret: CLIENT_SECRET,
    code: CODE,
    redirectUri: 'http://localhost:4001/callback',
    codeVerifier: CODE_VERIFIER,
    ...overrides,
});

// AS が、Basic のヘッダーを読む時と、同じ読み方(最初の : で分けて、form 形式を戻す)
const decodeBasic = (header: string | undefined) => {
    const encoded = /^Basic (\S+)$/.exec(header ?? '')?.[1] ?? '';
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const index = decoded.indexOf(':');
    const form = (value: string) =>
        decodeURIComponent(value.replace(/\+/g, ' '));
    return {
        clientId: form(decoded.slice(0, index)),
        clientSecret: form(decoded.slice(index + 1)),
    };
};

const lastRequest = () => {
    const request = server.requests.at(-1);
    if (!request) throw new Error('リクエストが届いていません');
    return request;
};

const expectFailed = (result: TokenExchangeResult) => {
    expect(result).toMatchObject({ ok: false, reason: 'failed' });
    if (result.ok || result.reason !== 'failed') throw new Error('unreachable');
    expect(result.message.length).toBeGreaterThan(0);
};

describe('TOKEN-REQUEST 認可コードの引き換え RFC 6749 4.1.3 / 2.3.1 / 5.1 / 5.2', () => {
    describe('exchangeCode', () => {
        describe('送るリクエスト', () => {
            it('トークンエンドポイントに、POST で、form 形式で送る', async () => {
                await exchangeCode(input());

                const request = lastRequest();
                expect(server.requests).toHaveLength(1);
                expect(request.method).toBe('POST');
                expect(request.url).toBe('/token');
                expect(request.headers['content-type']).toBe(
                    'application/x-www-form-urlencoded',
                );
                expect(request.headers['accept']).toContain('application/json');
            });

            it('本文は、grant_type、code、redirect_uri、code_verifier の 4 つだけ(各 1 回)', async () => {
                await exchangeCode(input());

                const params = new URLSearchParams(lastRequest().body);
                expect([...params.keys()].sort()).toEqual([
                    'code',
                    'code_verifier',
                    'grant_type',
                    'redirect_uri',
                ]);
                expect(params.get('grant_type')).toBe('authorization_code');
                expect(params.get('code')).toBe(CODE);
                expect(params.get('redirect_uri')).toBe(
                    'http://localhost:4001/callback',
                );
                expect(params.get('code_verifier')).toBe(CODE_VERIFIER);
            });

            it('クライアントの認証は、Authorization: Basic。本文にも URL にも、client_secret は入らない', async () => {
                await exchangeCode(input());

                const request = lastRequest();
                expect(decodeBasic(request.headers['authorization'])).toEqual({
                    clientId: 'memoboard',
                    clientSecret: CLIENT_SECRET,
                });
                expect(request.body).not.toContain(CLIENT_SECRET);
                expect(request.url).not.toContain(CLIENT_SECRET);
                expect(request.body).not.toContain('client_id');
            });

            it.each([
                { name: 'コロン', id: 'a:b', secret: 'x:y:z' },
                { name: '空白と +', id: 'my client', secret: 'a b+c' },
                { name: '% と &、=', id: 'id%41&x=1', secret: '100%&a=b' },
                { name: '日本語', id: 'メモボード', secret: '秘密の値' },
                { name: '引用符、記号', id: 'a"b\'c', secret: '!*()~;@/?#' },
            ])(
                'id と secret に $name があっても、AS が読んで、元の値に戻る(form 形式でエンコードしてから、Basic にする)',
                async ({ id, secret }) => {
                    await exchangeCode(
                        input({ clientId: id, clientSecret: secret }),
                    );

                    expect(
                        decodeBasic(lastRequest().headers['authorization']),
                    ).toEqual({ clientId: id, clientSecret: secret });
                },
            );

            it('エンコードした id は、コロンを含まない(最初のコロンで、id と secret を分けられる)', async () => {
                await exchangeCode(input({ clientId: 'a:b' }));

                const encoded =
                    /^Basic (\S+)$/.exec(
                        lastRequest().headers['authorization'] ?? '',
                    )?.[1] ?? '';
                const decoded = Buffer.from(encoded, 'base64').toString('utf8');
                expect(decoded.split(':')[0]).toBe('a%3Ab');
            });

            it('code、redirect_uri、code_verifier に、& や = や + や空白が入っていても、そのまま届く', async () => {
                const tricky = {
                    code: 'a&b=c+d e%20f',
                    redirectUri: 'http://localhost:4001/callback?x=1&y=2',
                    codeVerifier: 'v&w=x+y z',
                };

                await exchangeCode(input(tricky));

                const params = new URLSearchParams(lastRequest().body);
                expect(params.get('code')).toBe(tricky.code);
                expect(params.get('redirect_uri')).toBe(tricky.redirectUri);
                expect(params.get('code_verifier')).toBe(tricky.codeVerifier);
                expect([...params.keys()]).toHaveLength(4);
            });

            it('渡した物を、書き換えない', async () => {
                const original = input();
                const copy = { ...original };

                await exchangeCode(original);

                expect(original).toEqual(copy);
            });
        });

        describe('成功(200)', () => {
            it('アクセストークン、期限(今 + expires_in)、スコープが返る', async () => {
                const result = await exchangeCode(input(), {
                    now: () => 1_000_000,
                });

                expect(result).toEqual({
                    ok: true,
                    tokens: {
                        accessToken: ACCESS_TOKEN,
                        expiresAt: 1_000_600,
                        scope: 'read write',
                    },
                });
            });

            it('now を渡さなければ、本物の時計(秒)で、期限を作る', async () => {
                const before = Math.floor(Date.now() / 1000);
                const result = await exchangeCode(input());
                const after = Math.floor(Date.now() / 1000);

                expect(result.ok).toBe(true);
                if (!result.ok) return;
                expect(result.tokens.expiresAt).toBeGreaterThanOrEqual(
                    before + 600,
                );
                expect(result.tokens.expiresAt).toBeLessThanOrEqual(
                    after + 600,
                );
            });

            it('expires_in が無ければ、expiresAt は undefined', async () => {
                respond = (_r, res) =>
                    sendJson(res, 200, { ...okBody(), expires_in: undefined });

                const result = await exchangeCode(input());

                expect(result).toMatchObject({
                    ok: true,
                    tokens: { accessToken: ACCESS_TOKEN },
                });
                if (result.ok) expect(result.tokens.expiresAt).toBeUndefined();
            });

            it('scope が無ければ、undefined(要求した物と同じ、という意味)', async () => {
                respond = (_r, res) =>
                    sendJson(res, 200, { ...okBody(), scope: undefined });

                const result = await exchangeCode(input());

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.tokens.scope).toBeUndefined();
            });

            it.each(['Bearer', 'bearer', 'BEARER'])(
                'token_type は、大文字小文字を区別しない: %s',
                async (tokenType) => {
                    respond = (_r, res) =>
                        sendJson(res, 200, {
                            ...okBody(),
                            token_type: tokenType,
                        });

                    const result = await exchangeCode(input());

                    expect(result.ok).toBe(true);
                },
            );

            it('知らない項目(refresh_token など)は、無視する', async () => {
                respond = (_r, res) =>
                    sendJson(res, 200, {
                        ...okBody(),
                        refresh_token: 'refresh',
                        foo: { bar: 1 },
                    });

                const result = await exchangeCode(input(), { now: () => 0 });

                expect(result).toEqual({
                    ok: true,
                    tokens: {
                        accessToken: ACCESS_TOKEN,
                        expiresAt: 600,
                        scope: 'read write',
                    },
                });
            });

            it.each([
                { name: '英数字と記号(- . _ ~ + /)', token: 'Aa09-._~+/' },
                { name: '末尾の = (パディング)', token: 'YWJj==' },
            ])('アクセストークンに使える文字: $name', async ({ token }) => {
                respond = (_r, res) =>
                    sendJson(res, 200, { ...okBody(), access_token: token });

                const result = await exchangeCode(input());

                expect(result).toMatchObject({
                    ok: true,
                    tokens: { accessToken: token },
                });
            });
        });

        describe('200 だけど、返事が使えない: failed', () => {
            const cases = [
                { name: 'JSON ではない', raw: 'not json' },
                { name: '空の本文', raw: '' },
                { name: 'JSON の配列', raw: JSON.stringify([okBody()]) },
                { name: 'JSON の null', raw: 'null' },
                { name: 'JSON の文字列', raw: '"token"' },
                {
                    name: 'access_token が無い',
                    raw: JSON.stringify({
                        ...okBody(),
                        access_token: undefined,
                    }),
                },
                {
                    name: 'access_token が空文字',
                    raw: JSON.stringify({ ...okBody(), access_token: '' }),
                },
                {
                    name: 'access_token が数値',
                    raw: JSON.stringify({ ...okBody(), access_token: 12 }),
                },
                {
                    name: 'access_token に空白',
                    raw: JSON.stringify({ ...okBody(), access_token: 'a b' }),
                },
                {
                    name: 'access_token に改行(ヘッダーの注入)',
                    raw: JSON.stringify({
                        ...okBody(),
                        access_token: 'abc\r\nX-Evil: 1',
                    }),
                },
                {
                    name: 'access_token に引用符',
                    raw: JSON.stringify({ ...okBody(), access_token: 'a"b' }),
                },
                {
                    name: 'token_type が無い',
                    raw: JSON.stringify({ ...okBody(), token_type: undefined }),
                },
                {
                    name: 'token_type が Bearer ではない',
                    raw: JSON.stringify({ ...okBody(), token_type: 'MAC' }),
                },
                {
                    name: 'token_type が数値',
                    raw: JSON.stringify({ ...okBody(), token_type: 1 }),
                },
                {
                    name: 'expires_in が文字列',
                    raw: JSON.stringify({ ...okBody(), expires_in: '600' }),
                },
                {
                    name: 'expires_in が 0',
                    raw: JSON.stringify({ ...okBody(), expires_in: 0 }),
                },
                {
                    name: 'expires_in が負',
                    raw: JSON.stringify({ ...okBody(), expires_in: -1 }),
                },
                {
                    name: 'expires_in が小数',
                    raw: JSON.stringify({ ...okBody(), expires_in: 1.5 }),
                },
                {
                    name: 'expires_in が null',
                    raw: JSON.stringify({ ...okBody(), expires_in: null }),
                },
                {
                    name: 'scope が数値',
                    raw: JSON.stringify({ ...okBody(), scope: 1 }),
                },
                {
                    name: 'scope が空文字',
                    raw: JSON.stringify({ ...okBody(), scope: '' }),
                },
                {
                    name: 'scope の先頭に空白',
                    raw: JSON.stringify({ ...okBody(), scope: ' read' }),
                },
                {
                    name: 'scope の間に空白が 2 つ',
                    raw: JSON.stringify({ ...okBody(), scope: 'read  write' }),
                },
            ];

            it.each(cases)('$name', async ({ raw }) => {
                respond = (_r, res) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(raw);
                };

                expectFailed(await exchangeCode(input()));
            });
        });

        describe('AS が、OAuth のエラーで断った(400、401): rejected', () => {
            it('invalid_grant', async () => {
                respond = (_r, res) =>
                    sendJson(res, 400, { error: 'invalid_grant' });

                expect(await exchangeCode(input())).toEqual({
                    ok: false,
                    reason: 'rejected',
                    error: 'invalid_grant',
                });
            });

            it('error_description が付いていれば、それも返る', async () => {
                respond = (_r, res) =>
                    sendJson(res, 400, {
                        error: 'invalid_grant',
                        error_description: 'The code has expired',
                    });

                expect(await exchangeCode(input())).toEqual({
                    ok: false,
                    reason: 'rejected',
                    error: 'invalid_grant',
                    description: 'The code has expired',
                });
            });

            it('invalid_client(401、WWW-Authenticate 付き)', async () => {
                respond = (_r, res) =>
                    sendJson(
                        res,
                        401,
                        { error: 'invalid_client' },
                        { 'WWW-Authenticate': 'Basic realm="oauth-as"' },
                    );

                expect(await exchangeCode(input())).toEqual({
                    ok: false,
                    reason: 'rejected',
                    error: 'invalid_client',
                });
            });

            it.each([
                'invalid_request',
                'invalid_client',
                'invalid_grant',
                'unauthorized_client',
                'unsupported_grant_type',
                'invalid_scope',
            ])('RFC 6749 5.2 の error は、そのまま返る: %s', async (error) => {
                respond = (_r, res) => sendJson(res, 400, { error });

                expect(await exchangeCode(input())).toMatchObject({
                    ok: false,
                    reason: 'rejected',
                    error,
                });
            });

            it.each([
                { name: '日本語', value: '期限切れ' },
                { name: 'ダブルクォート', value: 'say "no"' },
                { name: '改行', value: 'a\nb' },
                { name: '数値', value: 12 },
                { name: '空文字', value: '' },
            ])(
                'error_description が使えない形($name)なら、捨てる(error は、返す)',
                async ({ value }) => {
                    respond = (_r, res) =>
                        sendJson(res, 400, {
                            error: 'invalid_grant',
                            error_description: value,
                        });

                    expect(await exchangeCode(input())).toEqual({
                        ok: false,
                        reason: 'rejected',
                        error: 'invalid_grant',
                    });
                },
            );

            it.each([
                { name: 'error が無い', body: { message: 'x' } },
                { name: 'error が数値', body: { error: 1 } },
                { name: 'error が空文字', body: { error: '' } },
                { name: 'error に日本語', body: { error: '拒否' } },
                { name: 'error にダブルクォート', body: { error: 'a"b' } },
                { name: '配列', body: [{ error: 'invalid_grant' }] },
            ])(
                '400 だけど、error が読めない($name): failed',
                async ({ body }) => {
                    respond = (_r, res) => sendJson(res, 400, body);

                    expectFailed(await exchangeCode(input()));
                },
            );

            it('400 で、JSON ではない本文: failed', async () => {
                respond = (_r, res) => {
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end('<html>bad request</html>');
                };

                expectFailed(await exchangeCode(input()));
            });
        });

        describe('それ以外の失敗: failed', () => {
            it.each([500, 502, 503])(
                'HTTP %i: failed。message に、ステータスが入る',
                async (status) => {
                    respond = (_r, res) => {
                        res.writeHead(status, { 'Content-Type': 'text/html' });
                        res.end('<html>error</html>');
                    };

                    const result = await exchangeCode(input());

                    expectFailed(result);
                    if (!result.ok && result.reason === 'failed')
                        expect(result.message).toContain(String(status));
                },
            );

            it.each([403, 404, 429])(
                'OAuth のエラーの形(JSON)が付いていても、HTTP %i は failed(rejected にするのは 400 と 401 だけ)',
                async (status) => {
                    respond = (_r, res) =>
                        sendJson(res, status, { error: 'invalid_grant' });

                    expectFailed(await exchangeCode(input()));
                },
            );

            it.each([201, 204, 202])(
                '200 以外の成功(%i)は、failed',
                async (status) => {
                    respond = (_r, res) => {
                        res.writeHead(status, {
                            'Content-Type': 'application/json',
                        });
                        res.end(
                            status === 204
                                ? undefined
                                : JSON.stringify(okBody()),
                        );
                    };

                    expectFailed(await exchangeCode(input()));
                },
            );

            it('転送(302)は辿らない。転送先には、リクエストを送らない', async () => {
                const target = await startStubServer((_r, res) =>
                    sendJson(res, 200, okBody()),
                );
                respond = (_r, res) => {
                    res.writeHead(302, {
                        Location: `${target.baseUrl}/token`,
                    });
                    res.end();
                };

                try {
                    expectFailed(await exchangeCode(input()));
                    expect(target.requests).toHaveLength(0);
                } finally {
                    await target.close();
                }
            });

            it('つながらない(サーバーが無い)ときは、failed', async () => {
                const dead = await startStubServer(() => {});
                const endpoint = `${dead.baseUrl}/token`;
                await dead.close();

                expectFailed(
                    await exchangeCode(input({ tokenEndpoint: endpoint })),
                );
            });

            it('返事が来なければ、timeoutMs で諦めて、failed', async () => {
                respond = () => {
                    // 返事を返さない
                };

                const started = Date.now();
                const result = await exchangeCode(input(), { timeoutMs: 150 });

                expectFailed(result);
                expect(Date.now() - started).toBeLessThan(3000);
            });

            it('トークンエンドポイントの URL が、おかしくても、例外を投げずに failed', async () => {
                expectFailed(
                    await exchangeCode(input({ tokenEndpoint: 'not a url' })),
                );
            });

            it('リトライはしない(1 回だけ送る)', async () => {
                respond = (_r, res) => sendJson(res, 503, { error: 'x' });

                await exchangeCode(input());

                expect(server.requests).toHaveLength(1);
            });
        });

        describe('秘密を、ログ用のメッセージに入れない', () => {
            it.each([
                {
                    name: '500',
                    handler: ((_r, res) => {
                        res.writeHead(500);
                        res.end(
                            `error for ${CLIENT_SECRET} ${CODE} ${CODE_VERIFIER}`,
                        );
                    }) as StubHandler,
                },
                {
                    name: '使えない access_token',
                    handler: ((_r, res) =>
                        sendJson(res, 200, {
                            ...okBody(),
                            access_token: 'bad token with space',
                        })) as StubHandler,
                },
                {
                    name: 'JSON ではない',
                    handler: ((_r, res) => {
                        res.writeHead(200);
                        res.end(`${CLIENT_SECRET}`);
                    }) as StubHandler,
                },
            ])('$name', async ({ handler }) => {
                respond = handler;

                const result = await exchangeCode(input());

                expectFailed(result);
                const message =
                    !result.ok && result.reason === 'failed'
                        ? result.message
                        : '';
                for (const secret of [
                    CLIENT_SECRET,
                    CODE,
                    CODE_VERIFIER,
                    ACCESS_TOKEN,
                    'bad token with space',
                ])
                    expect(message).not.toContain(secret);
            });
        });
    });
});
