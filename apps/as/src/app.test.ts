import { createHmac, generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createApp, type AppDeps } from './app.js';
import type { Config } from './lib/config.js';
import { sha256Hex } from './lib/hash.js';
import { hashPassword } from './lib/password.js';
import { computeCodeChallenge } from './lib/pkce.js';
import { generateRandomString } from './lib/random.js';
import { importSigningKey, type SigningKey } from './lib/signing-key.js';
import { createMemoryClientStore } from './stores/memory-client-store.js';
import { createMemoryCodeStore } from './stores/memory-code-store.js';
import { createMemoryUserStore } from './stores/memory-user-store.js';
import type { User } from './stores/user-store.js';
import {
    createClient,
    startServer,
    type TestServer,
} from './test-utils/http.js';
import {
    authorizeInBrowser,
    exchangeCode,
    type AuthorizeParams,
} from './test-utils/oauth-flow.js';

const CLIENT_ID = 'memoboard';
const CLIENT_SECRET = 'my-client-secret-for-testing-1234567890';
const REDIRECT_URI = 'http://localhost:3000/callback';
const PASSWORD = 'correct horse battery';
// 軽いコスト(テストを速くするため)
const FAST = { memoryCost: 1024, timeCost: 2, parallelism: 1 };

const config: Config = {
    issuer: 'http://localhost:4000',
    port: 4000,
    audience: 'simple-memo',
    signingKeyPath: 'unused',
    sessionSecret: 's'.repeat(32),
    codeTtlSec: 60,
    accessTokenTtlSec: 600,
    defaultScope: ['read'],
};

let signingKey: SigningKey;
let alice: User;
let bob: User;

beforeAll(async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    signingKey = await importSigningKey(privateKey);
    alice = {
        id: 'user-alice',
        username: 'alice',
        passwordHash: await hashPassword(PASSWORD, FAST),
    };
    bob = {
        id: 'user-bob',
        username: 'bob',
        passwordHash: await hashPassword('another password 1', FAST),
    };
}, 30_000);

// テストの中の時計(秒)。本物の時計とは、わざとずらす(渡した時計が、全部の所で使われているかを見るため)
const clock = { now: 0 };
let server: TestServer;

const makeDeps = (overrides: Partial<AppDeps> = {}): AppDeps => ({
    config,
    clientStore: createMemoryClientStore([
        {
            clientId: CLIENT_ID,
            secretHash: sha256Hex(CLIENT_SECRET),
            name: 'メモボード',
            redirectUris: [REDIRECT_URI],
        },
    ]),
    codeStore: createMemoryCodeStore(),
    userStore: createMemoryUserStore([alice, bob]),
    signingKey,
    now: () => clock.now,
    ...overrides,
});

beforeEach(async () => {
    // 本物の今より、約 1 日、先(アクセストークンは、期限が、さらに先なので、本物の時計で確かめても、有効)
    clock.now = Math.floor(Date.now() / 1000) + 100_000;
    server = await startServer(createApp(makeDeps()));
});

afterEach(async () => {
    await server.close();
});

// 1 回分の PKCE の組
const newPkce = () => {
    const verifier = generateRandomString();
    return { verifier, challenge: computeCodeChallenge(verifier) };
};

const aliceCredentials = { username: 'alice', password: PASSWORD };

const authorizeParams = (
    challenge: string,
    overrides: Partial<AuthorizeParams> = {},
): AuthorizeParams => ({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    ...overrides,
});

// 正しい /authorize の道(scope などを足したい時は、extra に)
const authorizePath = (challenge: string, extra = '') =>
    `/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256${extra}`;

const exchange = (code: string, verifier: string) =>
    exchangeCode(server.baseUrl, {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        code,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
    });

// ブラウザで、許可まで進んで、認可コードを取り出す
const getCode = async (
    browser = createClient(server.baseUrl),
    overrides: Partial<AuthorizeParams> = {},
    pkce = newPkce(),
) => {
    const callback = await authorizeInBrowser(
        browser,
        authorizeParams(pkce.challenge, overrides),
        aliceCredentials,
    );
    return { code: callback.searchParams.get('code') ?? '', pkce, callback };
};

// express-session と同じ形(s:<id>.<署名>)の Cookie の値を、自分で作る
const signedCookie = (sessionId: string, secret: string) => {
    const signature = createHmac('sha256', secret)
        .update(sessionId)
        .digest('base64')
        .replace(/=+$/, '');
    return encodeURIComponent(`s:${sessionId}.${signature}`);
};

describe('APP 認可サーバー全体(createApp) RFC 6749 4.1 / RFC 7636', () => {
    describe('認可コードの流れ(/authorize → /login → /consent → /token)', () => {
        it('ブラウザでログインして、同意して、アプリがトークンに引き換えられる', async () => {
            const pkce = newPkce();
            const browser = createClient(server.baseUrl);

            const callback = await authorizeInBrowser(
                browser,
                authorizeParams(pkce.challenge, {
                    scope: 'read write',
                    state: 'state-123',
                }),
                aliceCredentials,
            );

            expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
            expect(callback.searchParams.get('state')).toBe('state-123');
            const token = await exchange(
                callback.searchParams.get('code') ?? '',
                pkce.verifier,
            );
            expect(token.status).toBe(200);
            expect(token.json).toMatchObject({
                token_type: 'Bearer',
                expires_in: 600,
                scope: 'read write',
            });
        });

        it('アクセストークンは、ログインした人(sub)と、同意したスコープを持つ', async () => {
            const { code, pkce } = await getCode(undefined, {
                scope: 'read write',
            });

            const token = await exchange(code, pkce.verifier);

            const { payload, protectedHeader } = await jwtVerify(
                String(token.json['access_token']),
                signingKey.publicKey,
                { issuer: config.issuer, audience: config.audience },
            );
            expect(payload.sub).toBe(alice.id);
            expect(payload['client_id']).toBe(CLIENT_ID);
            expect(payload['scope']).toBe('read write');
            expect(protectedHeader.kid).toBe(signingKey.kid);
        });

        it('scope を省略したら、設定の既定のスコープ(read)になる', async () => {
            const { code, pkce } = await getCode();

            const token = await exchange(code, pkce.verifier);

            expect(token.status).toBe(200);
            expect(token.json['scope']).toBe('read');
        });

        it('認可コードは、1 回しか使えない(2 回目は invalid_grant)', async () => {
            const { code, pkce } = await getCode();

            const first = await exchange(code, pkce.verifier);
            const second = await exchange(code, pkce.verifier);

            expect(first.status).toBe(200);
            expect(second.status).toBe(400);
            expect(second.json).toEqual({ error: 'invalid_grant' });
        });

        it('別の code_verifier では、invalid_grant(PKCE: RFC 7636)', async () => {
            const { code } = await getCode();

            const token = await exchange(code, newPkce().verifier);

            expect(token.status).toBe(400);
            expect(token.json).toEqual({ error: 'invalid_grant' });
        });

        it('出鱈目な認可コードでは、invalid_grant', async () => {
            const token = await exchange(
                generateRandomString(),
                newPkce().verifier,
            );

            expect(token.status).toBe(400);
            expect(token.json).toEqual({ error: 'invalid_grant' });
        });

        it('認可コードの寿命の、手前(59 秒後)なら、まだ引き換えられる', async () => {
            const { code, pkce } = await getCode();

            clock.now += 59;
            const token = await exchange(code, pkce.verifier);

            expect(token.status).toBe(200);
        });

        it('認可コードの寿命(60 秒)が過ぎたら、invalid_grant(同意の側と、トークンの側が、同じ時計で動く)', async () => {
            const { code, pkce } = await getCode();

            clock.now += 60;
            const token = await exchange(code, pkce.verifier);

            expect(token.status).toBe(400);
            expect(token.json).toEqual({ error: 'invalid_grant' });
        });

        it('認可コードの寿命は、設定の CODE_TTL_SEC', async () => {
            await server.close();
            server = await startServer(
                createApp(makeDeps({ config: { ...config, codeTtlSec: 300 } })),
            );
            const { code, pkce } = await getCode();

            clock.now += 299;
            const token = await exchange(code, pkce.verifier);

            expect(token.status).toBe(200);
        });

        it('拒否すると、アプリには error=access_denied が戻って、コードは出ない', async () => {
            const pkce = newPkce();
            const browser = createClient(server.baseUrl);

            const callback = await authorizeInBrowser(
                browser,
                authorizeParams(pkce.challenge, { state: 'state-123' }),
                aliceCredentials,
                'deny',
            );

            expect(callback.searchParams.get('error')).toBe('access_denied');
            expect(callback.searchParams.get('state')).toBe('state-123');
            expect(callback.searchParams.has('code')).toBe(false);
        });
    });

    describe('ブラウザごとに、別々', () => {
        it('2 つのブラウザが、別々のユーザーで、別々のスコープを進めても、混ざらない', async () => {
            const browserA = createClient(server.baseUrl);
            const browserB = createClient(server.baseUrl);
            const pkceA = newPkce();
            const pkceB = newPkce();

            // 交互に進める(途中の状態が、混ざらないことを見るため)
            const startA = await browserA.get(
                authorizePath(pkceA.challenge, '&scope=read'),
            );
            const startB = await browserB.get(
                authorizePath(pkceB.challenge, '&scope=write'),
            );
            expect(startA.location).toBe('/login');
            expect(startB.location).toBe('/login');

            const callbackA = await authorizeInBrowser(
                browserA,
                authorizeParams(pkceA.challenge, { scope: 'read' }),
                aliceCredentials,
            );
            const callbackB = await authorizeInBrowser(
                browserB,
                authorizeParams(pkceB.challenge, { scope: 'write' }),
                { username: 'bob', password: 'another password 1' },
            );

            const tokenA = await exchange(
                callbackA.searchParams.get('code') ?? '',
                pkceA.verifier,
            );
            const tokenB = await exchange(
                callbackB.searchParams.get('code') ?? '',
                pkceB.verifier,
            );
            const verify = async (token: { json: Record<string, unknown> }) =>
                (
                    await jwtVerify(
                        String(token.json['access_token']),
                        signingKey.publicKey,
                        { issuer: config.issuer, audience: config.audience },
                    )
                ).payload;
            const payloadA = await verify(tokenA);
            const payloadB = await verify(tokenB);
            expect(payloadA.sub).toBe(alice.id);
            expect(payloadA['scope']).toBe('read');
            expect(payloadB.sub).toBe(bob.id);
            expect(payloadB['scope']).toBe('write');
        });

        it('1 回ログインしたブラウザは、次の /authorize で、ログインを飛ばして、同意に直行する', async () => {
            const browser = createClient(server.baseUrl);
            const first = await getCode(browser);
            const pkce = newPkce();

            const start = await browser.get(authorizePath(pkce.challenge));

            expect(start.status).toBe(303);
            expect(start.location).toBe('/consent');

            // その同意でも、別のコードが出て、引き換えられる
            const second = await getCode(browser, {}, pkce);
            expect(second.code).not.toBe(first.code);
            expect((await exchange(second.code, pkce.verifier)).status).toBe(
                200,
            );
        });
    });

    describe('/token と、セッション', () => {
        it('/token の応答には、Set-Cookie が付かない(セッションを使わない)', async () => {
            const { code, pkce } = await getCode();

            const token = await exchange(code, pkce.verifier);

            expect(token.status).toBe(200);
            expect(token.headers.getSetCookie()).toEqual([]);
        });

        it('/token のエラーの応答にも、Set-Cookie は付かない', async () => {
            const token = await exchange(
                generateRandomString(),
                newPkce().verifier,
            );

            expect(token.status).toBe(400);
            expect(token.headers.getSetCookie()).toEqual([]);
        });
    });

    describe('セッションの設定', () => {
        it('Cookie は、HttpOnly と SameSite=Lax(http の issuer なので、Secure は付けない)', async () => {
            const browser = createClient(server.baseUrl);

            const response = await browser.get(
                authorizePath(newPkce().challenge),
            );

            const [cookie = ''] = response.headers.getSetCookie();
            expect(cookie).toMatch(/^as_sid=/);
            expect(cookie).toContain('HttpOnly');
            expect(cookie).toContain('SameSite=Lax');
            expect(cookie).not.toContain('Secure');
        });

        it('Cookie の署名は、設定の SESSION_SECRET で作る(別の秘密で署名した Cookie は、受け付けない)', async () => {
            const owner = createClient(server.baseUrl);
            await owner.get(authorizePath(newPkce().challenge));
            const cookieValue = decodeURIComponent(
                owner.cookies.get('as_sid') ?? '',
            );
            // s:<セッション ID>.<署名>
            const sessionId = cookieValue.slice(
                2,
                cookieValue.lastIndexOf('.'),
            );

            const withRightSecret = createClient(server.baseUrl);
            withRightSecret.cookies.set(
                'as_sid',
                signedCookie(sessionId, config.sessionSecret),
            );
            const withWrongSecret = createClient(server.baseUrl);
            withWrongSecret.cookies.set(
                'as_sid',
                signedCookie(sessionId, 'x'.repeat(32)),
            );

            // 取っておいた認可リクエストが見えれば、ログイン画面(200)。見えなければ、400
            expect((await withRightSecret.get('/login')).status).toBe(200);
            expect((await withWrongSecret.get('/login')).status).toBe(400);
        });

        it('issuer が https なら、Secure 付きの Cookie を要求する(http のまま来ると、Cookie が出ない)', async () => {
            const secureServer = await startServer(
                createApp(
                    makeDeps({
                        config: {
                            ...config,
                            issuer: 'https://as.example.com',
                        },
                    }),
                ),
            );

            try {
                const browser = createClient(secureServer.baseUrl);
                const response = await browser.get(
                    authorizePath(newPkce().challenge),
                );

                // 認可リクエストは通る(303)けど、http のままでは、Secure な Cookie は、出ない
                expect(response.status).toBe(303);
                expect(response.headers.getSetCookie()).toEqual([]);
            } finally {
                await secureServer.close();
            }
        });
    });

    describe('画面と、エラー', () => {
        it('ログイン画面は、他のサイトの枠に入れられない', async () => {
            const browser = createClient(server.baseUrl);
            await browser.get(authorizePath(newPkce().challenge));

            const loginPage = await browser.get('/login');

            expect(loginPage.status).toBe(200);
            expect(loginPage.headers.get('x-frame-options')).toBe('DENY');
            expect(loginPage.headers.get('content-security-policy')).toContain(
                "frame-ancestors 'none'",
            );
        });

        it('client_id がおかしい /authorize は、リダイレクトせずに、400 のエラー画面', async () => {
            const browser = createClient(server.baseUrl);

            const response = await browser.get(
                `/authorize?response_type=code&client_id=unknown&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${newPkce().challenge}&code_challenge_method=S256`,
            );

            expect(response.status).toBe(400);
            expect(response.location).toBeNull();
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        });

        it('ルートが無い道は、この AS の 404 のエラー画面(ヘッダー付き)', async () => {
            const browser = createClient(server.baseUrl);

            const response = await browser.get('/nothing-here');

            expect(response.status).toBe(404);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.headers.get('x-frame-options')).toBe('DENY');
            // この AS のエラー画面(error.ejs)であること(Express の標準の 404 じゃない)
            expect(response.text).toContain('このページを閉じて');
        });

        it('X-Powered-By は出さない', async () => {
            const browser = createClient(server.baseUrl);

            const response = await browser.get('/nothing-here');

            expect(response.headers.has('x-powered-by')).toBe(false);
        });

        it('ストアが失敗しても、この AS の 500 のエラー画面で、中身は漏れない', async () => {
            const consoleError = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {});
            const faultyServer = await startServer(
                createApp(
                    makeDeps({
                        userStore: {
                            findByUsername: async () => {
                                throw new Error('USER-STORE-DOWN-DETAIL');
                            },
                            findById: async () => null,
                        },
                    }),
                ),
            );

            try {
                const browser = createClient(faultyServer.baseUrl);
                await browser.get(authorizePath(newPkce().challenge));
                const page = await browser.get('/login');
                const csrf =
                    /name="_csrf"[^>]*value="([^"]*)"/.exec(page.text)?.[1] ??
                    '';

                const response = await browser.postForm('/login', {
                    username: 'alice',
                    password: PASSWORD,
                    _csrf: csrf,
                });

                expect(response.status).toBe(500);
                expect(response.text).not.toContain('USER-STORE-DOWN-DETAIL');
                expect(response.text).toContain('このページを閉じて');
            } finally {
                await faultyServer.close();
                consoleError.mockRestore();
            }
        });
    });
});
