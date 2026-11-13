import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/hash.js';
import type { Client } from '../stores/client-store.js';
import { createMemoryClientStore } from '../stores/memory-client-store.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestServer,
} from '../test-utils/http.js';
import {
    createPageTestApp,
    readSession,
    TEST_USER_ID,
} from '../test-utils/page-app.js';
import { createAuthorizeRouter, type AuthorizeDeps } from './authorize.js';

const CLIENT_ID = 'memoboard';
const REDIRECT_URI = 'http://localhost:3000/callback';
// RFC 7636 付録 B の組の code_challenge
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const clients: Client[] = [
    {
        clientId: CLIENT_ID,
        secretHash: sha256Hex('secret-1'),
        name: 'メモボード',
        redirectUris: [REDIRECT_URI],
    },
    {
        // 登録した redirect_uri に、クエリが入っている
        clientId: 'query-app',
        secretHash: sha256Hex('secret-2'),
        name: 'クエリつき',
        redirectUris: ['https://other.example.com/cb?x=1'],
    },
    {
        // 登録した redirect_uri に、AS が付ける名前(state)が、もう入っている
        clientId: 'state-app',
        secretHash: sha256Hex('secret-3'),
        name: 'state つき',
        redirectUris: ['https://state.example.com/cb?state=fixed'],
    },
];

const baseDeps = (): AuthorizeDeps => ({
    clientStore: createMemoryClientStore(clients),
    supportedScopes: ['read', 'write'],
    defaultScope: ['read'],
});

const validParams = (): Record<string, string> => ({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
    scope: 'read',
    state: 'xyz',
});

// 正しいリクエストの道。overrides で、値を変える(undefined なら、その名前を付けない)
const authorizePath = (overrides: Record<string, string | undefined> = {}) => {
    const entries = Object.entries({ ...validParams(), ...overrides }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
    );
    return `/authorize?${new URLSearchParams(entries).toString()}`;
};

let server: TestServer;
let client: TestClient;
let consoleError: ReturnType<typeof vi.spyOn>;

const start = async (deps: AuthorizeDeps) => {
    server = await startServer(
        createPageTestApp((app) => {
            app.use('/authorize', createAuthorizeRouter(deps));
        }),
    );
    client = createClient(server.baseUrl);
};

// 別の設定で、起動し直す
const restart = async (deps: AuthorizeDeps) => {
    await server.close();
    await start(deps);
};

beforeEach(async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start(baseDeps());
});

afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
});

// リダイレクトの Location を、URL として読む
const locationOf = (response: { location: string | null }): URL => {
    expect(response.location).not.toBeNull();
    return new URL(response.location ?? '');
};

describe('AUTHORIZE 認可エンドポイント GET /authorize RFC 6749 3.1 / 4.1.1', () => {
    describe('正しいリクエスト', () => {
        it('ログインしていなければ、/login にリダイレクトする(303)', async () => {
            const response = await client.get(authorizePath());

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
        });

        it('ログイン済みなら、/consent にリダイレクトする(303)', async () => {
            await client.get('/__test/login');

            const response = await client.get(authorizePath());

            expect(response.status).toBe(303);
            expect(response.location).toBe('/consent');
        });

        it('認可リクエストを、セッションに取っておく', async () => {
            await client.get(authorizePath());

            const session = await readSession(client);
            expect(session.pending).toEqual({
                clientId: CLIENT_ID,
                redirectUri: REDIRECT_URI,
                scope: ['read'],
                state: 'xyz',
                codeChallenge: CODE_CHALLENGE,
            });
        });

        it('セッションの Cookie を出す(取っておくために)', async () => {
            const response = await client.get(authorizePath());

            expect(response.headers.getSetCookie()).toHaveLength(1);
            expect(client.cookies.has('as_sid')).toBe(true);
        });

        it('ログインしていなければ、セッションに userId は無い', async () => {
            await client.get(authorizePath());

            expect((await readSession(client)).userId).toBeNull();
        });

        it('ログイン済みでも、ログインの記録は、消えない', async () => {
            await client.get('/__test/login');
            await client.get(authorizePath());

            expect((await readSession(client)).userId).toBe(TEST_USER_ID);
        });

        it('state が無くても、通る(取っておく物にも、state は無い)', async () => {
            const response = await client.get(
                authorizePath({ state: undefined }),
            );

            expect(response.status).toBe(303);
            const { pending } = await readSession(client);
            expect(pending).not.toBeNull();
            expect(pending).not.toHaveProperty('state');
        });

        it('値が空のパラメータは、付いてないのと同じ(state が空なら、state 無し)', async () => {
            const response = await client.get(authorizePath({ state: '' }));

            expect(response.status).toBe(303);
            expect(await readSession(client)).toMatchObject({
                pending: { clientId: CLIENT_ID },
            });
            expect((await readSession(client)).pending).not.toHaveProperty(
                'state',
            );
        });

        it('scope が無ければ、既定のスコープになる', async () => {
            await client.get(authorizePath({ scope: undefined }));

            expect((await readSession(client)).pending?.scope).toEqual([
                'read',
            ]);
        });

        it('scope が空文字なら、付いてないのと同じ(既定のスコープになる)', async () => {
            await client.get(authorizePath({ scope: '' }));

            expect((await readSession(client)).pending?.scope).toEqual([
                'read',
            ]);
        });

        it('既定のスコープは、設定から来る', async () => {
            await restart({ ...baseDeps(), defaultScope: ['write'] });

            await client.get(authorizePath({ scope: undefined }));

            expect((await readSession(client)).pending?.scope).toEqual([
                'write',
            ]);
        });

        it('scope は、重複を除いて、並べ替えて取っておく', async () => {
            await client.get(authorizePath({ scope: 'write read read' }));

            expect((await readSession(client)).pending?.scope).toEqual([
                'read',
                'write',
            ]);
        });

        it('知らないパラメータは、無視する', async () => {
            const response = await client.get(
                `${authorizePath()}&prompt=login&foo=bar`,
            );

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
        });

        it('登録した redirect_uri にクエリが入っていても、通る', async () => {
            const response = await client.get(
                authorizePath({
                    client_id: 'query-app',
                    redirect_uri: 'https://other.example.com/cb?x=1',
                }),
            );

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
            expect((await readSession(client)).pending?.redirectUri).toBe(
                'https://other.example.com/cb?x=1',
            );
        });

        it('2 回目のリクエストで、取っておく物が、上書きされる(最後の物が残る)', async () => {
            await client.get(authorizePath({ state: 'first' }));
            await client.get(authorizePath({ state: 'second' }));

            expect((await readSession(client)).pending?.state).toBe('second');
        });

        it('おかしいリクエストが来ても、先に取っておいた物は、壊れない', async () => {
            await client.get(authorizePath({ state: 'first' }));

            // 比べるために、ページで知らせる場合と、リダイレクトで知らせる場合の、両方
            const pageError = await client.get(
                authorizePath({ client_id: 'unknown-app' }),
            );
            const redirectError = await client.get(
                authorizePath({ response_type: 'token' }),
            );

            expect(pageError.status).toBe(400);
            expect(redirectError.status).toBe(303);
            expect((await readSession(client)).pending?.state).toBe('first');
        });
    });

    describe('ページで知らせる(RFC 6749 4.1.2.1: client_id や redirect_uri がおかしい時は、リダイレクトしない)', () => {
        const clientIdCases = [
            {
                name: 'client_id が無い',
                path: authorizePath({ client_id: undefined }),
            },
            { name: 'client_id が空', path: authorizePath({ client_id: '' }) },
            {
                name: '知らない client_id',
                path: authorizePath({ client_id: 'unknown-app' }),
            },
            {
                name: 'client_id が 2 回ある',
                path: `${authorizePath()}&client_id=other-app`,
            },
        ];

        const redirectUriCases = [
            {
                name: 'redirect_uri が無い',
                path: authorizePath({ redirect_uri: undefined }),
            },
            {
                name: '登録と違うホスト',
                path: authorizePath({
                    redirect_uri: 'http://evil.example.com/callback',
                }),
            },
            {
                name: '末尾に / が付いている',
                path: authorizePath({
                    redirect_uri: 'http://localhost:3000/callback/',
                }),
            },
            {
                name: '大文字小文字が違う',
                path: authorizePath({
                    redirect_uri: 'http://localhost:3000/Callback',
                }),
            },
            {
                name: 'クエリが付いている',
                path: authorizePath({ redirect_uri: `${REDIRECT_URI}?a=b` }),
            },
            {
                name: 'redirect_uri が 2 回ある',
                path: `${authorizePath()}&redirect_uri=http://evil.example.com/callback`,
            },
        ];

        it.each([...clientIdCases, ...redirectUriCases])(
            '400 のエラー画面で、リダイレクトしない: $name',
            async ({ path }) => {
                const response = await client.get(path);

                expect(response.status).toBe(400);
                expect(response.headers.get('content-type')).toMatch(
                    /^text\/html/,
                );
                expect(response.location).toBeNull();
            },
        );

        it.each([...clientIdCases, ...redirectUriCases])(
            'セッションには、何も残さない(Cookie も出さない): $name',
            async ({ path }) => {
                const response = await client.get(path);

                expect(response.status).toBe(400);
                expect(response.headers.getSetCookie()).toEqual([]);
                expect(client.cookies.size).toBe(0);
            },
        );

        it.each(clientIdCases)(
            'client_id の問題だと、画面で分かる: $name',
            async ({ path }) => {
                const response = await client.get(path);

                expect(response.text).toContain('client_id');
                expect(response.text).not.toContain('redirect_uri');
            },
        );

        it.each(redirectUriCases)(
            'redirect_uri の問題だと、画面で分かる: $name',
            async ({ path }) => {
                const response = await client.get(path);

                expect(response.text).toContain('redirect_uri');
                expect(response.text).not.toContain('client_id');
            },
        );

        it('両方おかしければ、client_id の問題として知らせる(client_id を先に確かめる)', async () => {
            const response = await client.get(
                authorizePath({
                    client_id: 'unknown-app',
                    redirect_uri: 'http://evil.example.com/callback',
                }),
            );

            expect(response.status).toBe(400);
            expect(response.text).toContain('client_id');
            expect(response.text).not.toContain('redirect_uri');
        });

        it('届いた client_id を、そのまま画面に出さない', async () => {
            const response = await client.get(
                authorizePath({ client_id: '<script>alert(1)</script>' }),
            );

            expect(response.status).toBe(400);
            expect(response.text).not.toContain('alert(1)');
            expect(response.text).not.toContain('<script>');
        });

        it('届いた redirect_uri を、そのまま画面に出さない', async () => {
            const response = await client.get(
                authorizePath({ redirect_uri: 'javascript:alert(1)' }),
            );

            expect(response.status).toBe(400);
            expect(response.text).not.toContain('javascript:alert');
            expect(response.text).not.toContain('alert(1)');
        });

        it('ストアの探し方が、client_id をそのまま使っても、__proto__ などで壊れない', async () => {
            const response = await client.get(
                authorizePath({ client_id: '__proto__' }),
            );

            expect(response.status).toBe(400);
            expect(response.text).toContain('client_id');
        });
    });

    describe('リダイレクトで知らせる(client_id と redirect_uri は正しい時)', () => {
        const errorCases = [
            {
                name: 'response_type が無い',
                overrides: { response_type: undefined },
                error: 'invalid_request',
            },
            {
                name: 'response_type が空',
                overrides: { response_type: '' },
                error: 'invalid_request',
            },
            {
                name: 'response_type が token',
                overrides: { response_type: 'token' },
                error: 'unsupported_response_type',
            },
            {
                name: 'code_challenge が無い',
                overrides: { code_challenge: undefined },
                error: 'invalid_request',
            },
            {
                name: 'code_challenge が短い',
                overrides: { code_challenge: 'abc' },
                error: 'invalid_request',
            },
            {
                name: 'code_challenge_method が無い',
                overrides: { code_challenge_method: undefined },
                error: 'invalid_request',
            },
            {
                name: 'code_challenge_method が plain',
                overrides: { code_challenge_method: 'plain' },
                error: 'invalid_request',
            },
            {
                name: 'code_challenge_method が s256(小文字)',
                overrides: { code_challenge_method: 's256' },
                error: 'invalid_request',
            },
            {
                name: 'scope の形が不正',
                overrides: { scope: 'read "write"' },
                error: 'invalid_scope',
            },
            {
                name: 'scope が未対応',
                overrides: { scope: 'admin' },
                error: 'invalid_scope',
            },
            {
                name: 'scope の一部が未対応',
                overrides: { scope: 'read admin' },
                error: 'invalid_scope',
            },
        ];

        it.each(errorCases)(
            'redirect_uri に、error をつけて戻す(303): $name',
            async ({ overrides, error }) => {
                const response = await client.get(authorizePath(overrides));

                expect(response.status).toBe(303);
                const url = locationOf(response);
                expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
                expect(url.searchParams.get('error')).toBe(error);
                expect(url.searchParams.get('error_description')).toBeTruthy();
            },
        );

        it.each(errorCases)(
            'state も、そのまま戻す(RFC 6749 4.1.2.1): $name',
            async ({ overrides }) => {
                const response = await client.get(authorizePath(overrides));

                expect(locationOf(response).searchParams.get('state')).toBe(
                    'xyz',
                );
            },
        );

        it.each(errorCases)(
            'code は付けない。セッションにも、Cookie にも、何も残さない: $name',
            async ({ overrides }) => {
                const response = await client.get(authorizePath(overrides));

                expect(locationOf(response).searchParams.has('code')).toBe(
                    false,
                );
                expect(response.headers.getSetCookie()).toEqual([]);
                expect(client.cookies.size).toBe(0);
            },
        );

        it.each([
            { name: 'response_type', extra: 'response_type=code' },
            {
                name: 'code_challenge',
                extra: `code_challenge=${CODE_CHALLENGE}`,
            },
            {
                name: 'code_challenge_method',
                extra: 'code_challenge_method=S256',
            },
            { name: 'scope', extra: 'scope=read' },
        ])(
            '$name が 2 回ある(RFC 6749 3.1: 同じ名前は 1 回だけ): invalid_request で、state は戻す',
            async ({ extra }) => {
                const response = await client.get(
                    `${authorizePath()}&${extra}`,
                );

                expect(response.status).toBe(303);
                const url = locationOf(response);
                expect(url.searchParams.get('error')).toBe('invalid_request');
                expect(url.searchParams.get('state')).toBe('xyz');
            },
        );

        it.each([
            {
                name: '制御文字(0x7F)を含む',
                path: authorizePath({ state: 'a\u007fb' }),
            },
            { name: '日本語を含む', path: authorizePath({ state: 'あいう' }) },
            {
                name: 'state が 2 回ある',
                path: `${authorizePath({ state: undefined })}&state=a&state=b`,
            },
        ])(
            'state の形が不正なら、invalid_request で、state は戻さない: $name',
            async ({ path }) => {
                const response = await client.get(path);

                expect(response.status).toBe(303);
                const url = locationOf(response);
                expect(url.searchParams.get('error')).toBe('invalid_request');
                expect(url.searchParams.has('state')).toBe(false);
            },
        );

        it('state に使える記号(空白、~)も、そのまま戻る', async () => {
            const response = await client.get(
                authorizePath({ response_type: 'token', state: 'a b~c' }),
            );

            expect(locationOf(response).searchParams.get('state')).toBe(
                'a b~c',
            );
        });

        it('登録した redirect_uri のクエリは、そのまま残る(RFC 6749 3.1.2)', async () => {
            const response = await client.get(
                authorizePath({
                    client_id: 'query-app',
                    redirect_uri: 'https://other.example.com/cb?x=1',
                    response_type: 'token',
                }),
            );

            expect(response.status).toBe(303);
            expect(response.location).toMatch(
                /^https:\/\/other\.example\.com\/cb\?x=1&error=unsupported_response_type/,
            );
            expect(locationOf(response).searchParams.get('x')).toBe('1');
        });

        it('出せるスコープは、設定から来る', async () => {
            await restart({ ...baseDeps(), supportedScopes: ['read'] });

            const response = await client.get(
                authorizePath({ scope: 'write' }),
            );

            expect(locationOf(response).searchParams.get('error')).toBe(
                'invalid_scope',
            );
        });
    });

    describe('GET 以外のメソッド', () => {
        it('POST は、405 で、Allow: GET', async () => {
            const response = await client.postForm('/authorize', {
                ...validParams(),
            });

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
        });

        it.each(['PUT', 'DELETE', 'PATCH'])(
            '%s は、405 で、Allow: GET',
            async (method) => {
                const response = await fetch(
                    `${server.baseUrl}${authorizePath()}`,
                    {
                        method,
                        redirect: 'manual',
                    },
                );

                expect(response.status).toBe(405);
                expect(response.headers.get('allow')).toBe('GET');
            },
        );

        it('405 の時は、セッションにも Cookie にも、何も残さない', async () => {
            const response = await client.postForm('/authorize', {
                ...validParams(),
            });

            expect(response.status).toBe(405);
            expect(client.cookies.size).toBe(0);
        });
    });

    describe('中で失敗した時', () => {
        it('ストアが失敗したら、500 のエラー画面(中身は出さない)', async () => {
            await restart({
                ...baseDeps(),
                clientStore: {
                    find: async () => {
                        throw new Error('STORE-DOWN-DETAIL');
                    },
                },
            });

            const response = await client.get(authorizePath());

            expect(response.status).toBe(500);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.text).not.toContain('STORE-DOWN-DETAIL');
            expect(consoleError).toHaveBeenCalledOnce();
        });

        it('登録した redirect_uri に、戻す名前(state)が、もう入っていたら、500 のエラー画面(中身は出さない)', async () => {
            const response = await client.get(
                authorizePath({
                    client_id: 'state-app',
                    redirect_uri: 'https://state.example.com/cb?state=fixed',
                    response_type: 'token',
                    state: 'abc',
                }),
            );

            expect(response.status).toBe(500);
            expect(response.location).toBeNull();
            expect(response.text).not.toContain('same parameters');
            expect(consoleError).toHaveBeenCalledOnce();
        });
    });

    describe('キャッシュさせない(画面にも、リダイレクトにも)', () => {
        it.each([
            { name: '正しいリクエスト(303)', path: authorizePath() },
            {
                name: 'ページで知らせる(400)',
                path: authorizePath({ client_id: 'unknown-app' }),
            },
            {
                name: 'リダイレクトで知らせる(303)',
                path: authorizePath({ response_type: 'token' }),
            },
        ])(
            'Cache-Control: no-store と Pragma: no-cache: $name',
            async ({ path }) => {
                const response = await client.get(path);

                expect(response.headers.get('cache-control')).toBe('no-store');
                expect(response.headers.get('pragma')).toBe('no-cache');
            },
        );

        it('405 でも付く', async () => {
            const response = await client.postForm('/authorize', {});

            expect(response.status).toBe(405);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });
    });
});
