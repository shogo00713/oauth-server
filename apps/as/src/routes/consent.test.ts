import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureCsrfToken } from '../lib/csrf.js';
import { sha256Hex } from '../lib/hash.js';
import type { Client } from '../stores/client-store.js';
import type { AuthCodeRecord, CodeStore } from '../stores/code-store.js';
import { createMemoryClientStore } from '../stores/memory-client-store.js';
import { createMemoryCodeStore } from '../stores/memory-code-store.js';
import { createMemoryUserStore } from '../stores/memory-user-store.js';
import type { User } from '../stores/user-store.js';
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
import { createConsentRouter, type ConsentDeps } from './consent.js';

// テストの中の「今」(秒)
const NOW = 1_700_000_000;
const CODE_TTL = 60;
const REDIRECT_URI = 'http://localhost:3000/callback';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const clients: Client[] = [
    {
        clientId: 'memoboard',
        secretHash: sha256Hex('secret-1'),
        name: 'メモボード',
        redirectUris: [REDIRECT_URI],
    },
    {
        // 名前に、HTML が入っている(画面で、エスケープされること)
        clientId: 'xss-app',
        secretHash: sha256Hex('secret-2'),
        name: '<script>alert(1)</script>',
        redirectUris: [REDIRECT_URI],
    },
    {
        // 登録した redirect_uri に、クエリが入っている
        clientId: 'query-app',
        secretHash: sha256Hex('secret-3'),
        name: 'クエリつき',
        redirectUris: ['https://other.example.com/cb?x=1'],
    },
    {
        // 登録した redirect_uri に、AS が付ける名前(state)が、もう入っている
        clientId: 'state-app',
        secretHash: sha256Hex('secret-4'),
        name: 'state つき',
        redirectUris: ['https://state.example.com/cb?state=fixed'],
    },
];

const alice: User = {
    id: TEST_USER_ID,
    username: 'alice',
    passwordHash: 'unused-in-these-tests',
};

// 認可コードのストアに、save された物の記録(テストで、見るため)
type Saved = { hash: string; record: AuthCodeRecord };
let saved: Saved[];

let server: TestServer;
let client: TestClient;
let consoleError: ReturnType<typeof vi.spyOn>;

const makeDeps = (overrides: Partial<ConsentDeps> = {}): ConsentDeps => {
    const inner = createMemoryCodeStore();
    const codeStore: CodeStore = {
        save: async (hash, record) => {
            saved.push({ hash, record });
            await inner.save(hash, record);
        },
        consume: (hash, now) => inner.consume(hash, now),
    };
    return {
        clientStore: createMemoryClientStore(clients),
        userStore: createMemoryUserStore([alice]),
        codeStore,
        codeTtlSec: CODE_TTL,
        now: () => NOW,
        ...overrides,
    };
};

const start = async (deps: ConsentDeps) => {
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: 認可リクエストを取っておいたことにする
            //   ?client=、?scope=(コンマ区切り)、?state=(__none__ なら state 無し)、?redirect=
            app.get('/__test/pending', (req, res) => {
                const state = String(req.query['state'] ?? 'xyz');
                req.session.pending = {
                    clientId: String(req.query['client'] ?? 'memoboard'),
                    redirectUri: String(req.query['redirect'] ?? REDIRECT_URI),
                    scope: String(req.query['scope'] ?? 'read').split(','),
                    state: state === '__none__' ? undefined : state,
                    codeChallenge: CODE_CHALLENGE,
                };
                res.send('ok');
            });
            app.get('/__test/clear-pending', (req, res) => {
                delete req.session.pending;
                res.send('ok');
            });
            // テスト専用の道: CSRF トークンを、セッションに作って、返す
            app.get('/__test/csrf', (req, res) => {
                res.send(ensureCsrfToken(req.session));
            });
            app.use('/consent', createConsentRouter(deps));
        }),
    );
    client = createClient(server.baseUrl);
};

// 別の設定で、起動し直す
const restart = async (deps: ConsentDeps) => {
    await server.close();
    await start(deps);
};

beforeEach(async () => {
    saved = [];
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await start(makeDeps());
});

afterEach(async () => {
    await server.close();
    consoleError.mockRestore();
});

// 画面の HTML から、フォームの CSRF トークンを取り出す
const csrfOf = (html: string): string =>
    /<input[^>]*name="_csrf"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '';

// 認可リクエストを取っておいて、(ログインして)、同意の画面を開く準備をする
const prepare = async (query = '', loggedIn = true) => {
    await client.get(`/__test/pending${query}`);
    if (loggedIn) await client.get('/__test/login');
};

const openConsent = async () => {
    const response = await client.get('/consent');
    return { response, csrf: csrfOf(response.text) };
};

const decide = (
    csrf: string,
    decision: string,
    extra: Record<string, string> = {},
) => client.postForm('/consent', { _csrf: csrf, decision, ...extra });

// ブラウザと同じ手順で、同意する / 拒否する(画面を開いて、ボタンを押す)
const consentWith = async (decision: string, query = '') => {
    await prepare(query);
    const { csrf } = await openConsent();
    return decide(csrf, decision);
};

// フォームの本文を、そのまま送る(同じ名前を 2 回、などを試すため)。client の Cookie を付ける
const rawPost = async (
    body: string,
    contentType = 'application/x-www-form-urlencoded',
) => {
    const cookie = [...client.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    const response = await fetch(`${server.baseUrl}/consent`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': contentType,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
    });
    return {
        status: response.status,
        text: await response.text(),
        location: response.headers.get('location'),
    };
};

// リダイレクトの Location を、URL として読む
const locationOf = (response: { location: string | null }): URL => {
    expect(response.location).not.toBeNull();
    return new URL(response.location ?? '');
};

const PENDING_DEFAULT = {
    clientId: 'memoboard',
    redirectUri: REDIRECT_URI,
    scope: ['read'],
    state: 'xyz',
    codeChallenge: CODE_CHALLENGE,
};

describe('CONSENT 同意 /consent RFC 6749 10.2 / 10.12 / 4.1.2', () => {
    describe('GET /consent(同意の画面)', () => {
        it('ログイン済みで、認可リクエストがあれば、同意の画面(HTML)を返す', async () => {
            await prepare();

            const { response } = await openConsent();

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        });

        it('どのアプリかを、画面に出す', async () => {
            await prepare();

            const { response } = await openConsent();

            expect(response.text).toContain('メモボード');
        });

        it('アプリの名前の中の HTML は、エスケープして出す', async () => {
            await prepare('?client=xss-app');

            const { response } = await openConsent();

            expect(response.text).toContain('&lt;script&gt;alert(1)');
            expect(response.text).not.toContain('<script>alert(1)');
        });

        it('ログインしているユーザーの名前を、画面に出す', async () => {
            await prepare();

            const { response } = await openConsent();

            expect(response.text).toContain('alice');
        });

        it('求められたスコープを、全部、説明つきで出す', async () => {
            await prepare('?scope=read,write');

            const { response } = await openConsent();

            expect(response.text).toContain('read');
            expect(response.text).toContain('メモを読む');
            expect(response.text).toContain('write');
            expect(response.text).toContain('メモを作る・書き換える・消す');
        });

        it('スコープが read だけなら、write の説明は出さない', async () => {
            await prepare('?scope=read');

            const { response } = await openConsent();

            expect(response.text).toContain('メモを読む');
            expect(response.text).not.toContain('メモを作る・書き換える・消す');
        });

        it('知らないスコープは、名前だけ出す(説明は付けない)', async () => {
            await prepare('?scope=custom-scope');

            const { response } = await openConsent();

            expect(response.text).toContain('custom-scope');
        });

        it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
            'Object の名前のスコープでも、関数の中身を、画面に出さない: %s',
            async (scope) => {
                await prepare(`?scope=${scope}`);

                const { response } = await openConsent();

                expect(response.status).toBe(200);
                expect(response.text).toContain(scope);
                expect(response.text).not.toContain('function');
                expect(response.text).not.toContain('native code');
            },
        );

        it('スコープの名前の中の HTML は、エスケープして出す', async () => {
            await prepare(`?scope=${encodeURIComponent('<b>x</b>')}`);

            const { response } = await openConsent();

            expect(response.text).toContain('&lt;b&gt;x&lt;/b&gt;');
            expect(response.text).not.toContain('<b>x</b>');
        });

        it('フォームは、/consent に POST する。許可と拒否のボタンがある', async () => {
            await prepare();

            const { response } = await openConsent();

            expect(response.text).toMatch(
                /<form[^>]*method="post"[^>]*action="\/consent"/,
            );
            expect(response.text).toMatch(
                /<button[^>]*name="decision"[^>]*value="allow"/,
            );
            expect(response.text).toMatch(
                /<button[^>]*name="decision"[^>]*value="deny"/,
            );
        });

        it('フォームに CSRF トークンを入れて、同じ物を、セッションにも入れる', async () => {
            await prepare();

            const { csrf } = await openConsent();

            expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect((await readSession(client)).csrfToken).toBe(csrf);
        });

        it('開き直しても、同じトークン', async () => {
            await prepare();
            const first = await openConsent();

            const second = await client.get('/consent');

            expect(csrfOf(second.text)).toBe(first.csrf);
        });

        it('画面を出しただけでは、認可コードを出さない。取っておいた物も、そのまま', async () => {
            await prepare();

            await openConsent();

            expect(saved).toHaveLength(0);
            expect((await readSession(client)).pending).toEqual(
                PENDING_DEFAULT,
            );
        });

        it('クリックジャッキング対策(RFC 9700 4.16): 他のサイトの枠に入れられない', async () => {
            await prepare();

            const { response } = await openConsent();

            expect(response.headers.get('x-frame-options')).toBe('DENY');
            expect(response.headers.get('content-security-policy')).toContain(
                "frame-ancestors 'none'",
            );
        });

        it('認可リクエストが無ければ、400 のエラー画面', async () => {
            await client.get('/__test/login');

            const response = await client.get('/consent');

            expect(response.status).toBe(400);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        });

        it('認可リクエストが無く、ログインもしてなければ、400 のエラー画面(先に、リクエストを確かめる)', async () => {
            const response = await client.get('/consent');

            expect(response.status).toBe(400);
        });

        it('ログインしていなければ、/login に 303', async () => {
            await prepare('', false);

            const response = await client.get('/consent');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
        });

        it('取っておいた client_id が、名簿に無ければ、400 のエラー画面', async () => {
            await prepare('?client=gone-app');

            const response = await client.get('/consent');

            expect(response.status).toBe(400);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        });

        it('ログインの記録のユーザーが、名簿に居なければ、記録を消して、/login に 303(行き来し続けない)', async () => {
            await restart(makeDeps({ userStore: createMemoryUserStore([]) }));
            await prepare();

            const response = await client.get('/consent');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
            expect((await readSession(client)).userId).toBeNull();
        });

        it('ストアが失敗したら、500 のエラー画面(中身は出さない)', async () => {
            await restart(
                makeDeps({
                    clientStore: {
                        find: async () => {
                            throw new Error('CLIENT-STORE-DOWN-DETAIL');
                        },
                    },
                }),
            );
            await prepare();

            const response = await client.get('/consent');

            expect(response.status).toBe(500);
            expect(response.text).not.toContain('CLIENT-STORE-DOWN-DETAIL');
        });
    });

    describe('POST /consent: 許可する', () => {
        it('303 で、redirect_uri に、code と state をつけて戻す', async () => {
            const response = await consentWith('allow');

            expect(response.status).toBe(303);
            const url = locationOf(response);
            expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
            expect(url.searchParams.get('code')).toBeTruthy();
            expect(url.searchParams.get('state')).toBe('xyz');
            expect(url.searchParams.has('error')).toBe(false);
        });

        it('認可コードは、推測されない長さ(RFC 6749 10.10: 160 ビット以上が望ましい)', async () => {
            const response = await consentWith('allow');

            const code = locationOf(response).searchParams.get('code') ?? '';
            expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
            expect(
                Buffer.from(code, 'base64url').length,
            ).toBeGreaterThanOrEqual(20);
        });

        it('同意するたびに、別のコードが出る', async () => {
            const first = await consentWith('allow');
            const second = await consentWith('allow');

            expect(locationOf(first).searchParams.get('code')).not.toBe(
                locationOf(second).searchParams.get('code'),
            );
        });

        it('コードは、そのままじゃなくて、SHA-256 のハッシュをキーにして、ストアに 1 件だけ保存する', async () => {
            const response = await consentWith('allow');

            const code = locationOf(response).searchParams.get('code') ?? '';
            expect(saved).toHaveLength(1);
            expect(saved[0]?.hash).toBe(sha256Hex(code));
            expect(saved[0]?.hash).not.toBe(code);
        });

        it('保存する中身: アプリ、redirect_uri、code_challenge、ユーザー、スコープ、期限', async () => {
            await consentWith('allow', '?scope=read,write');

            expect(saved[0]?.record).toEqual({
                clientId: 'memoboard',
                redirectUri: REDIRECT_URI,
                codeChallenge: CODE_CHALLENGE,
                sub: TEST_USER_ID,
                scope: ['read', 'write'],
                expiresAt: NOW + CODE_TTL,
            });
        });

        it('期限は、今の時刻に、設定の寿命を足した物', async () => {
            await restart(makeDeps({ codeTtlSec: 300 }));

            await consentWith('allow');

            expect(saved[0]?.record.expiresAt).toBe(NOW + 300);
        });

        it('時計を渡さなければ、本物の時計(秒)で、期限を決める', async () => {
            await restart(makeDeps({ now: undefined }));
            const before = Math.floor(Date.now() / 1000);

            await consentWith('allow');

            const expiresAt = saved[0]?.record.expiresAt ?? 0;
            expect(expiresAt).toBeGreaterThanOrEqual(before + CODE_TTL);
            expect(expiresAt).toBeLessThanOrEqual(
                Math.floor(Date.now() / 1000) + CODE_TTL,
            );
        });

        it('フォームに、sub や scope などを足して送っても、保存する中身は変わらない', async () => {
            await prepare('?scope=read');
            const { csrf } = await openConsent();

            await decide(csrf, 'allow', {
                sub: 'evil-user',
                userId: 'evil-user',
                scope: 'read write admin',
                client_id: 'xss-app',
                redirect_uri: 'http://evil.example.com/callback',
                code_challenge: 'evil-challenge',
            });

            expect(saved).toHaveLength(1);
            expect(saved[0]?.record).toMatchObject({
                clientId: 'memoboard',
                redirectUri: REDIRECT_URI,
                codeChallenge: CODE_CHALLENGE,
                sub: TEST_USER_ID,
                scope: ['read'],
            });
        });

        it('取っておいた認可リクエストを消す。ログインの記録は、残す', async () => {
            await consentWith('allow');

            const session = await readSession(client);
            expect(session.pending).toBeNull();
            expect(session.userId).toBe(TEST_USER_ID);
        });

        it('state が無いリクエストなら、戻す URL にも state は付けない', async () => {
            const response = await consentWith('allow', '?state=__none__');

            const url = locationOf(response);
            expect(url.searchParams.get('code')).toBeTruthy();
            expect(url.searchParams.has('state')).toBe(false);
        });

        it('state に使える記号(空白、~)も、そのまま戻る', async () => {
            const response = await consentWith(
                'allow',
                `?state=${encodeURIComponent('a b~c')}`,
            );

            expect(locationOf(response).searchParams.get('state')).toBe(
                'a b~c',
            );
        });

        it('登録した redirect_uri のクエリは、そのまま残る(RFC 6749 3.1.2)', async () => {
            const response = await consentWith(
                'allow',
                `?client=query-app&redirect=${encodeURIComponent('https://other.example.com/cb?x=1')}`,
            );

            expect(response.location).toMatch(
                /^https:\/\/other\.example\.com\/cb\?x=1&code=/,
            );
            expect(locationOf(response).searchParams.get('x')).toBe('1');
        });

        it('同じフォームを、もう一度送っても、2 つ目のコードは出ない(400)', async () => {
            await prepare();
            const { csrf } = await openConsent();
            const first = await decide(csrf, 'allow');

            const second = await decide(csrf, 'allow');

            expect(first.status).toBe(303);
            expect(second.status).toBe(400);
            expect(saved).toHaveLength(1);
        });

        it('許可したあとに、/consent を開いても、400(取っておいた物が、もう無い)', async () => {
            await consentWith('allow');

            const response = await client.get('/consent');

            expect(response.status).toBe(400);
        });
    });

    describe('POST /consent: 拒否する', () => {
        it('303 で、redirect_uri に、error=access_denied と state をつけて戻す(RFC 6749 4.1.2.1)', async () => {
            const response = await consentWith('deny');

            expect(response.status).toBe(303);
            const url = locationOf(response);
            expect(`${url.origin}${url.pathname}`).toBe(REDIRECT_URI);
            expect(url.searchParams.get('error')).toBe('access_denied');
            expect(url.searchParams.get('state')).toBe('xyz');
        });

        it('code は付けない。認可コードも、保存しない', async () => {
            const response = await consentWith('deny');

            expect(locationOf(response).searchParams.has('code')).toBe(false);
            expect(saved).toHaveLength(0);
        });

        it('取っておいた認可リクエストを消す。ログインの記録は、残す', async () => {
            await consentWith('deny');

            const session = await readSession(client);
            expect(session.pending).toBeNull();
            expect(session.userId).toBe(TEST_USER_ID);
        });

        it('state が無いリクエストなら、戻す URL にも state は付けない', async () => {
            const response = await consentWith('deny', '?state=__none__');

            const url = locationOf(response);
            expect(url.searchParams.get('error')).toBe('access_denied');
            expect(url.searchParams.has('state')).toBe(false);
        });

        it('登録した redirect_uri のクエリは、そのまま残る', async () => {
            const response = await consentWith(
                'deny',
                `?client=query-app&redirect=${encodeURIComponent('https://other.example.com/cb?x=1')}`,
            );

            expect(response.location).toMatch(
                /^https:\/\/other\.example\.com\/cb\?x=1&error=access_denied/,
            );
        });

        it('同じフォームを、もう一度送っても、400', async () => {
            await prepare();
            const { csrf } = await openConsent();
            await decide(csrf, 'deny');

            const second = await decide(csrf, 'allow');

            expect(second.status).toBe(400);
            expect(saved).toHaveLength(0);
        });
    });

    describe('POST /consent: decision が、おかしい時', () => {
        const cases = [
            { name: 'decision が無い', body: (c: string) => `_csrf=${c}` },
            {
                name: 'decision が空',
                body: (c: string) => `_csrf=${c}&decision=`,
            },
            {
                name: '大文字(ALLOW)',
                body: (c: string) => `_csrf=${c}&decision=ALLOW`,
            },
            { name: 'yes', body: (c: string) => `_csrf=${c}&decision=yes` },
            {
                name: 'allow,deny',
                body: (c: string) => `_csrf=${c}&decision=allow,deny`,
            },
            {
                name: 'allow が 2 回',
                body: (c: string) => `_csrf=${c}&decision=allow&decision=allow`,
            },
            {
                name: 'allow と deny',
                body: (c: string) => `_csrf=${c}&decision=allow&decision=deny`,
            },
        ];

        it.each(cases)(
            '400 のエラー画面。コードは出さない。取っておいた物も、残す: $name',
            async ({ body }) => {
                await prepare();
                const { csrf } = await openConsent();

                const response = await rawPost(body(csrf));

                expect(response.status).toBe(400);
                expect(response.location).toBeNull();
                expect(saved).toHaveLength(0);
                expect((await readSession(client)).pending).toEqual(
                    PENDING_DEFAULT,
                );
            },
        );
    });

    describe('POST /consent: CSRF(RFC 6749 10.12: 持ち主が、はっきり同意したのでなければ、認可を得られないように)', () => {
        it.each([
            { name: '_csrf が無い', fieldsOf: () => ({ decision: 'allow' }) },
            {
                name: '_csrf が違う',
                fieldsOf: () => ({ _csrf: 'wrong-token', decision: 'allow' }),
            },
            {
                name: '_csrf が空',
                fieldsOf: () => ({ _csrf: '', decision: 'allow' }),
            },
        ])(
            '403 のエラー画面。コードは出さない。取っておいた物も、残す: $name',
            async ({ fieldsOf }) => {
                await prepare();
                await openConsent();

                const response = await client.postForm('/consent', fieldsOf());

                expect(response.status).toBe(403);
                expect(response.headers.get('content-type')).toMatch(
                    /^text\/html/,
                );
                expect(response.location).toBeNull();
                expect(saved).toHaveLength(0);
                expect((await readSession(client)).pending).toEqual(
                    PENDING_DEFAULT,
                );
            },
        );

        it('_csrf が 2 回ある時も、403', async () => {
            await prepare();
            const { csrf } = await openConsent();

            const response = await rawPost(
                `_csrf=${csrf}&_csrf=${csrf}&decision=allow`,
            );

            expect(response.status).toBe(403);
            expect(saved).toHaveLength(0);
        });

        it('セッションが無い(Cookie が無い)まま、トークンだけ付けて送っても、403', async () => {
            await prepare();
            const { csrf } = await openConsent();
            const stranger = createClient(server.baseUrl);

            const response = await stranger.postForm('/consent', {
                _csrf: csrf,
                decision: 'allow',
            });

            expect(response.status).toBe(403);
            expect(stranger.cookies.size).toBe(0);
            expect(saved).toHaveLength(0);
        });

        it('別の人(別のセッション)のトークンでは、403', async () => {
            await prepare();
            const { csrf: aliceToken } = await openConsent();
            const other = createClient(server.baseUrl);
            await other.get('/__test/pending');
            await other.get('/__test/login');
            await other.get('/consent');

            const response = await other.postForm('/consent', {
                _csrf: aliceToken,
                decision: 'allow',
            });

            expect(response.status).toBe(403);
            expect(saved).toHaveLength(0);
        });

        it('フォームの形式じゃない本文(JSON)でも、500 にならず 403', async () => {
            await prepare();
            const { csrf } = await openConsent();

            const response = await rawPost(
                JSON.stringify({ _csrf: csrf, decision: 'allow' }),
                'application/json',
            );

            expect(response.status).toBe(403);
            expect(saved).toHaveLength(0);
        });

        it('本文が無くても、500 にならず 403', async () => {
            await prepare();
            await openConsent();

            const response = await rawPost('');

            expect(response.status).toBe(403);
        });
    });

    describe('POST /consent: ログインしてない時、取っておいた物が無い時', () => {
        it('ログインしてない人が、(CSRF が合っていても)許可を送ると、/login に 303。コードは出さない', async () => {
            await prepare('', false);
            const token = (await client.get('/__test/csrf')).text;

            const response = await decide(token, 'allow');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
            expect(saved).toHaveLength(0);
        });

        it('CSRF が合っていても、取っておいた物が無ければ、400。コードは出さない', async () => {
            await prepare();
            const { csrf } = await openConsent();
            await client.get('/__test/clear-pending');

            const response = await decide(csrf, 'allow');

            expect(response.status).toBe(400);
            expect(saved).toHaveLength(0);
        });

        it('取っておいた client_id が、名簿に無ければ、400。コードは出さない', async () => {
            await prepare();
            const { csrf } = await openConsent();
            await client.get('/__test/pending?client=gone-app');

            const response = await decide(csrf, 'allow');

            expect(response.status).toBe(400);
            expect(saved).toHaveLength(0);
        });

        it('ログインの記録のユーザーが、名簿に居なければ、記録を消して、/login に 303。コードは出さない', async () => {
            await restart(makeDeps({ userStore: createMemoryUserStore([]) }));
            await prepare();
            const token = (await client.get('/__test/csrf')).text;

            const response = await decide(token, 'allow');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/login');
            expect((await readSession(client)).userId).toBeNull();
            expect(saved).toHaveLength(0);
        });
    });

    describe('POST /consent: 中で失敗した時', () => {
        it('コードの保存が失敗したら、500 のエラー画面(中身は出さない)。取っておいた物は、残す', async () => {
            await restart(
                makeDeps({
                    codeStore: {
                        save: async () => {
                            throw new Error('CODE-STORE-DOWN-DETAIL');
                        },
                        consume: async () => null,
                    },
                }),
            );
            await prepare();
            const { csrf } = await openConsent();

            const response = await decide(csrf, 'allow');

            expect(response.status).toBe(500);
            expect(response.location).toBeNull();
            expect(response.text).not.toContain('CODE-STORE-DOWN-DETAIL');
            expect(consoleError).toHaveBeenCalledOnce();
            expect((await readSession(client)).pending).toEqual(
                PENDING_DEFAULT,
            );
        });

        it('登録した redirect_uri に、戻す名前(state)が、もう入っていたら、許可は 500。コードは保存しない。取っておいた物は、残す', async () => {
            const query = `?client=state-app&redirect=${encodeURIComponent('https://state.example.com/cb?state=fixed')}`;
            await prepare(query);
            const { csrf } = await openConsent();

            const response = await decide(csrf, 'allow');

            expect(response.status).toBe(500);
            expect(response.location).toBeNull();
            expect(saved).toHaveLength(0);
            expect((await readSession(client)).pending).not.toBeNull();
        });

        it('同じ場合の、拒否も 500。取っておいた物は、残す', async () => {
            const query = `?client=state-app&redirect=${encodeURIComponent('https://state.example.com/cb?state=fixed')}`;
            await prepare(query);
            const { csrf } = await openConsent();

            const response = await decide(csrf, 'deny');

            expect(response.status).toBe(500);
            expect(response.location).toBeNull();
            expect((await readSession(client)).pending).not.toBeNull();
        });
    });

    describe('GET と POST 以外のメソッド', () => {
        it.each(['PUT', 'DELETE', 'PATCH'])(
            '%s は、405 で、Allow: GET, POST',
            async (method) => {
                const response = await fetch(`${server.baseUrl}/consent`, {
                    method,
                    redirect: 'manual',
                });

                expect(response.status).toBe(405);
                expect(response.headers.get('allow')).toBe('GET, POST');
            },
        );
    });

    describe('キャッシュさせない(画面にも、リダイレクトにも)', () => {
        it('同意の画面(200)', async () => {
            await prepare();

            const { response } = await openConsent();

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('許可のリダイレクト(303)', async () => {
            const response = await consentWith('allow');

            expect(response.status).toBe(303);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('拒否のリダイレクト(303)', async () => {
            const response = await consentWith('deny');

            expect(response.status).toBe(303);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('403 のエラー画面', async () => {
            await prepare();
            await openConsent();

            const response = await client.postForm('/consent', {
                _csrf: 'wrong-token',
                decision: 'allow',
            });

            expect(response.status).toBe(403);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('400 のエラー画面', async () => {
            const response = await client.get('/consent');

            expect(response.status).toBe(400);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('405', async () => {
            const response = await fetch(`${server.baseUrl}/consent`, {
                method: 'PUT',
            });

            expect(response.status).toBe(405);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });
    });
});
