import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { jwtVerify } from 'jose';
import { createApp, type AppDeps } from '../app.js';
import type { Config } from '../lib/config.js';
import { sha256Hex } from '../lib/hash.js';
import { importSigningKey, type SigningKey } from '../lib/signing-key.js';
import type { Client } from '../stores/client-store.js';
import type { AuthCodeRecord, CodeStore } from '../stores/code-store.js';
import { createMemoryClientStore } from '../stores/memory-client-store.js';
import { createMemoryCodeStore } from '../stores/memory-code-store.js';

const NOW = 1_700_000_000;
const CLIENT_ID = 'memoboard';
const CLIENT_SECRET = 'my-client-secret';
const REDIRECT_URI = 'http://localhost:3000/callback';
const CODE = 'authorization-code-for-test';
// RFC 7636 付録 B の組
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const WRONG_VERIFIER = 'A'.repeat(43);
const BASIC_CHALLENGE = 'Basic realm="oauth-as"';

const config: Config = {
    issuer: 'http://localhost:4000',
    port: 4000,
    audience: 'simple-memo',
    signingKeyPath: 'unused',
    codeTtlSec: 60,
    accessTokenTtlSec: 600,
    defaultScope: ['read'],
};

const clients: Client[] = [
    {
        clientId: CLIENT_ID,
        secretHash: sha256Hex(CLIENT_SECRET),
        name: 'メモボード',
        redirectUris: [REDIRECT_URI],
    },
    {
        clientId: 'other-app',
        secretHash: sha256Hex('other-secret'),
        name: '別のアプリ',
        redirectUris: ['https://other.example.com/cb'],
    },
];

const record = (overrides: Partial<AuthCodeRecord> = {}): AuthCodeRecord => ({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    sub: 'user-1',
    scope: ['read', 'write'],
    expiresAt: NOW + 60,
    ...overrides,
});

const validBody = () => ({
    grant_type: 'authorization_code',
    code: CODE,
    redirect_uri: REDIRECT_URI,
    code_verifier: CODE_VERIFIER,
});

const bodyWithout = (key: keyof ReturnType<typeof validBody>) => {
    const { [key]: _removed, ...rest } = validBody();
    return rest;
};

const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

type RunningServer = { baseUrl: string; close: () => Promise<void> };

const startApp = async (deps: AppDeps): Promise<RunningServer> => {
    const server = createApp(deps).listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
};

type Options = {
    auth?: string | null;
    contentType?: string;
    body?: Record<string, string> | string;
};

type Result = {
    status: number;
    headers: Headers;
    text: string;
    json: unknown;
};

const postToken = async (
    baseUrl: string,
    options: Options = {},
): Promise<Result> => {
    const headers: Record<string, string> = {
        'Content-Type':
            options.contentType ?? 'application/x-www-form-urlencoded',
    };
    const auth =
        options.auth === undefined
            ? basic(CLIENT_ID, CLIENT_SECRET)
            : options.auth;
    if (auth !== null) headers['Authorization'] = auth;

    const body = options.body ?? validBody();
    const res = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers,
        body: typeof body === 'string' ? body : new URLSearchParams(body),
    });
    const text = await res.text();
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: res.status, headers: res.headers, text, json };
};

// エラー返事の、共通の形(RFC 6749 5.2)
const expectError = (res: Result, status: number, error: string) => {
    expect(res.status).toBe(status);
    expect(res.json).toEqual({ error });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('pragma')).toBe('no-cache');
};

let signingKey: SigningKey;

beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    signingKey = await importSigningKey(privateKey);
}, 30_000);

const clock = { now: NOW };
let codeStore: CodeStore;
let server: RunningServer;

const post = (options: Options = {}) => postToken(server.baseUrl, options);

beforeEach(async () => {
    clock.now = NOW;
    codeStore = createMemoryCodeStore();
    await codeStore.save(sha256Hex(CODE), record());
    server = await startApp({
        config,
        clientStore: createMemoryClientStore(clients),
        codeStore,
        signingKey,
        now: () => clock.now,
    });
});

afterEach(async () => {
    await server.close();
});

describe('TOKEN ENDPOINT RFC 6749 4.1.3 / 5.1 / 5.2 / RFC 9068', () => {
    describe('POST /token', () => {
        describe('成功', () => {
            it('200 で、access_token、token_type、expires_in、scope が返る', async () => {
                const res = await post();

                expect(res.status).toBe(200);
                expect(res.json).toEqual({
                    access_token: expect.any(String),
                    token_type: 'Bearer',
                    expires_in: 600,
                    scope: 'read write',
                });
            });

            it('JSON で返って、キャッシュさせない(RFC 6749 5.1 の MUST)', async () => {
                const res = await post();

                expect(res.headers.get('content-type')).toContain(
                    'application/json',
                );
                expect(res.headers.get('cache-control')).toBe('no-store');
                expect(res.headers.get('pragma')).toBe('no-cache');
            });

            it('access_token は、公開鍵で検証できて、クレームが正しい(RFC 9068 2.2)', async () => {
                const res = await post();
                const { access_token } = res.json as { access_token: string };

                const { payload, protectedHeader } = await jwtVerify(
                    access_token,
                    signingKey.publicKey,
                    {
                        issuer: config.issuer,
                        audience: config.audience,
                        typ: 'at+jwt',
                        currentDate: new Date((NOW + 10) * 1000),
                    },
                );

                expect(payload).toEqual({
                    iss: config.issuer,
                    sub: 'user-1',
                    aud: config.audience,
                    client_id: CLIENT_ID,
                    scope: 'read write',
                    iat: NOW,
                    exp: NOW + 600,
                    jti: expect.any(String),
                });
                expect(protectedHeader.kid).toBe(signingKey.kid);
            });

            it('now を渡さなければ、今の時刻で動く(本番と同じ)', async () => {
                const nowSec = Math.floor(Date.now() / 1000);
                const realClockCodeStore = createMemoryCodeStore();
                await realClockCodeStore.save(
                    sha256Hex(CODE),
                    record({ expiresAt: nowSec + 60 }),
                );
                const realClock = await startApp({
                    config,
                    clientStore: createMemoryClientStore(clients),
                    codeStore: realClockCodeStore,
                    signingKey,
                });

                try {
                    const res = await postToken(realClock.baseUrl);
                    const { access_token } = res.json as {
                        access_token: string;
                    };

                    expect(res.status).toBe(200);
                    const { payload } = await jwtVerify(
                        access_token,
                        signingKey.publicKey,
                        { issuer: config.issuer, audience: config.audience },
                    );
                    expect(payload.iat).toBeGreaterThanOrEqual(nowSec);
                    expect(payload.iat).toBeLessThanOrEqual(nowSec + 5);
                } finally {
                    await realClock.close();
                }
            });

            it('ボディに、Basic と同じ client_id を付けても、通る', async () => {
                const res = await post({
                    body: { ...validBody(), client_id: CLIENT_ID },
                });

                expect(res.status).toBe(200);
            });

            it('知らないパラメータは、無視する', async () => {
                const res = await post({
                    body: { ...validBody(), foo: 'bar' },
                });

                expect(res.status).toBe(200);
            });

            it('code[x] のような名前は、入れ子にならず、別のパラメータとして無視される', async () => {
                const res = await post({
                    body: { ...validBody(), 'code[x]': '1' },
                });

                expect(res.status).toBe(200);
            });
        });

        describe('認可コードは、1 回きり', () => {
            it('同じコードで 2 回目は、400 invalid_grant', async () => {
                await post();

                expectError(await post(), 400, 'invalid_grant');
            });
        });

        describe('クライアント認証(401 invalid_client)', () => {
            it.each([
                { name: 'Authorization ヘッダーが無い', auth: null },
                { name: 'Basic じゃない(Bearer)', auth: 'Bearer abc' },
                { name: 'Base64 が壊れている', auth: 'Basic !!!' },
                {
                    name: '知らないクライアント',
                    auth: basic('nobody', CLIENT_SECRET),
                },
                {
                    name: 'secret が違う',
                    auth: basic(CLIENT_ID, 'wrong-secret'),
                },
                { name: 'secret が空', auth: basic(CLIENT_ID, '') },
            ])('401 と WWW-Authenticate: $name', async ({ auth }) => {
                const res = await post({ auth });

                expectError(res, 401, 'invalid_client');
                expect(res.headers.get('www-authenticate')).toBe(
                    BASIC_CHALLENGE,
                );
            });

            it('知らないクライアントと、secret が違う場合は、全く同じ返事', async () => {
                const unknown = await post({
                    auth: basic('nobody', CLIENT_SECRET),
                });
                const wrongSecret = await post({
                    auth: basic(CLIENT_ID, 'wrong-secret'),
                });

                expect(unknown.status).toBe(wrongSecret.status);
                expect(unknown.text).toBe(wrongSecret.text);
            });

            it('認証に失敗しても、認可コードは使われない', async () => {
                await post({ auth: basic(CLIENT_ID, 'wrong-secret') });

                expect((await post()).status).toBe(200);
            });

            it('クライアント認証が、ボディの検査より先', async () => {
                const res = await post({
                    auth: basic(CLIENT_ID, 'wrong-secret'),
                    body: { ...validBody(), grant_type: 'password' },
                });

                expect(res.status).toBe(401);
            });
        });

        describe('ボディが不正(400)', () => {
            it.each([
                {
                    name: 'grant_type が違う',
                    body: { ...validBody(), grant_type: 'password' },
                    error: 'unsupported_grant_type',
                },
                {
                    name: 'grant_type が無い',
                    body: bodyWithout('grant_type'),
                    error: 'invalid_request',
                },
                {
                    name: 'code が無い',
                    body: bodyWithout('code'),
                    error: 'invalid_request',
                },
                {
                    name: 'redirect_uri が無い',
                    body: bodyWithout('redirect_uri'),
                    error: 'invalid_request',
                },
                {
                    name: 'code_verifier が無い',
                    body: bodyWithout('code_verifier'),
                    error: 'invalid_request',
                },
                {
                    name: 'code_verifier が短い',
                    body: { ...validBody(), code_verifier: 'short' },
                    error: 'invalid_request',
                },
                {
                    name: 'client_secret がボディにある',
                    body: { ...validBody(), client_secret: CLIENT_SECRET },
                    error: 'invalid_request',
                },
                {
                    name: 'ボディの client_id が、Basic の client_id と違う',
                    body: { ...validBody(), client_id: 'other-app' },
                    error: 'invalid_request',
                },
                { name: 'ボディが空', body: '', error: 'invalid_request' },
            ])('$name', async ({ body, error }) => {
                expectError(await post({ body }), 400, error);
            });

            it('同じパラメータが 2 回ある', async () => {
                const body = new URLSearchParams([
                    ...Object.entries(validBody()),
                    ['code', 'second-code'],
                ]).toString();

                expectError(await post({ body }), 400, 'invalid_request');
            });

            it.each([
                { name: 'JSON で送る', contentType: 'application/json' },
                { name: 'text/plain で送る', contentType: 'text/plain' },
            ])(
                'Content-Type がフォームじゃない: $name',
                async ({ contentType }) => {
                    const res = await post({
                        contentType,
                        body: JSON.stringify(validBody()),
                    });

                    expectError(res, 400, 'invalid_request');
                },
            );

            it('ボディが大きすぎる(200KB)でも、JSON のエラーで返る', async () => {
                const res = await post({ body: 'a=' + 'x'.repeat(200 * 1024) });

                expectError(res, 400, 'invalid_request');
            });

            it('ボディが不正でも、認可コードは使われない', async () => {
                await post({
                    body: { ...validBody(), grant_type: 'password' },
                });
                await post({
                    body: { ...validBody(), client_id: 'other-app' },
                });

                expect((await post()).status).toBe(200);
            });
        });

        describe('認可コードが認められない(400 invalid_grant)', () => {
            it.each([
                {
                    name: '知らないコード',
                    body: { ...validBody(), code: 'unknown-code' },
                },
                {
                    name: 'redirect_uri が違う',
                    body: {
                        ...validBody(),
                        redirect_uri: 'http://localhost:3000/other',
                    },
                },
                {
                    name: 'redirect_uri の末尾に / がある(完全一致じゃない)',
                    body: { ...validBody(), redirect_uri: `${REDIRECT_URI}/` },
                },
                {
                    name: 'code_verifier が違う',
                    body: { ...validBody(), code_verifier: WRONG_VERIFIER },
                },
            ])('$name', async ({ body }) => {
                expectError(await post({ body }), 400, 'invalid_grant');
            });

            it('期限の 1 秒前は、通る', async () => {
                clock.now = NOW + 59;

                expect((await post()).status).toBe(200);
            });

            it('ちょうど期限は、通らない', async () => {
                clock.now = NOW + 60;

                expectError(await post(), 400, 'invalid_grant');
            });

            it('別のクライアントに発行されたコードは、通らない', async () => {
                await codeStore.save(
                    sha256Hex('other-code'),
                    record({ clientId: 'other-app' }),
                );

                const res = await post({
                    body: { ...validBody(), code: 'other-code' },
                });

                expectError(res, 400, 'invalid_grant');
            });

            it('照合に失敗したコードは、もう使えない', async () => {
                await post({
                    body: { ...validBody(), code_verifier: WRONG_VERIFIER },
                });

                expectError(await post(), 400, 'invalid_grant');
            });
        });

        describe('POST 以外', () => {
            it.each(['GET', 'PUT', 'DELETE', 'PATCH'])(
                '%s は、405 と Allow: POST',
                async (method) => {
                    const res = await fetch(`${server.baseUrl}/token`, {
                        method,
                    });

                    expect(res.status).toBe(405);
                    expect(res.headers.get('allow')).toBe('POST');
                },
            );
        });

        describe('想定外の例外', () => {
            it.each([
                {
                    name: '普通の例外',
                    error: new Error('内部の情報: db-password=hunter2'),
                },
                {
                    name: 'status が 503 の例外(5xx は、400 にしない)',
                    error: Object.assign(
                        new Error('内部の情報: db-password=hunter2'),
                        { status: 503 },
                    ),
                },
            ])(
                'ストアが例外を投げたら、500 と server_error。例外の中身は、レスポンスに出ない: $name',
                async ({ error }) => {
                    const errorSpy = vi
                        .spyOn(console, 'error')
                        .mockImplementation(() => {});
                    const faultyCodeStore: CodeStore = {
                        save: async () => {},
                        consume: async () => {
                            throw error;
                        },
                    };
                    const faulty = await startApp({
                        config,
                        clientStore: createMemoryClientStore(clients),
                        codeStore: faultyCodeStore,
                        signingKey,
                        now: () => NOW,
                    });

                    try {
                        const res = await postToken(faulty.baseUrl);

                        expectError(res, 500, 'server_error');
                        expect(res.text).not.toContain('hunter2');
                        expect(res.text).not.toContain('Error');
                        expect(errorSpy).toHaveBeenCalled();
                    } finally {
                        await faulty.close();
                        errorSpy.mockRestore();
                    }
                },
            );
        });
    });
});
