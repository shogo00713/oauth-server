import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import type { Config } from './lib/config.js';
import { SESSION_COOKIE_NAME } from './lib/session.js';
import { createMemoApi } from './rs/memo-api.js';
import {
    FAKE_ACCESS_TOKEN,
    startFakeBackends,
    type FakeBackends,
} from './test-utils/fake-backends.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestServer,
} from './test-utils/http.js';

const CLIENT_SECRET = 'client-secret-for-test-0123456789abcdef';
const SESSION_SECRET = 's'.repeat(32);
// 誰にも届かない道(接続を断られる)
const DEAD_URL = 'http://127.0.0.1:1';

let backends: FakeBackends;
let server: TestServer;
let browser: TestClient;
// テストの中の時計(秒)。省略したら、本物の時計
let clock: (() => number) | undefined;

const makeConfig = (overrides: Partial<Config> = {}): Config => ({
    baseUrl: 'http://localhost:4001',
    port: 4001,
    asBaseUrl: 'http://localhost:4000',
    rsBaseUrl: backends.rsBaseUrl,
    clientId: 'memoboard',
    clientSecret: CLIENT_SECRET,
    sessionSecret: SESSION_SECRET,
    requestedScope: 'read write',
    redirectUri: 'http://localhost:4001/callback',
    authorizationEndpoint: 'http://localhost:4000/authorize',
    tokenEndpoint: `${backends.asBaseUrl}/token`,
    ...overrides,
});

const start = async (overrides: Partial<Config> = {}) => {
    const config = makeConfig(overrides);
    return startServer(
        createApp({
            config,
            memoApi: createMemoApi({ baseUrl: config.rsBaseUrl }),
            now: clock,
        }),
    );
};

beforeEach(async () => {
    clock = undefined;
    backends = await startFakeBackends();
    server = await start();
    browser = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
    await backends.close();
});

// 認可リクエストを始めて、AS から戻ってきたことにする(AS は、偽。state だけ、本物を使う)
const login = async (who: TestClient = browser, code = 'code-1') => {
    const started = await who.get('/login');
    const authorize = new URL(started.location ?? '');
    const state = authorize.searchParams.get('state') ?? '';
    const callback = await who.get(
        `/callback?${new URLSearchParams({ code, state })}`,
    );
    return { started, authorize, callback };
};

const csrfOf = (html: string) =>
    /name="_csrf" value="([^"]*)"/.exec(html)?.[1] ?? '';

// 偽の RS に、メモを入れておく
const seedMemos = (...bodies: string[]) => {
    bodies.forEach((body, index) => {
        const at = `2026-10-01T00:00:0${index}.000Z`;
        backends.memos.push({
            id: `s${index + 1}`,
            body,
            createdAt: at,
            updatedAt: at,
        });
    });
};

const signedCookie = (sessionId: string, secret: string) => {
    const signature = createHmac('sha256', secret)
        .update(sessionId)
        .digest('base64')
        .replace(/=+$/, '');
    return encodeURIComponent(`s:${sessionId}.${signature}`);
};

describe('APP メモボード全体(createApp) RFC 6749 4.1 / RFC 7636', () => {
    describe('ブラウザでの、最初から最後までの流れ', () => {
        it('ログイン前の / は、ログインを促す画面。RS は、呼ばない', async () => {
            const response = await browser.get('/');

            expect(response.status).toBe(200);
            expect(response.text).toContain('href="/login"');
            expect(backends.rsRequests).toHaveLength(0);
        });

        it('/login は、設定の認可エンドポイントへ、設定の値と PKCE つきで、飛ばす', async () => {
            const response = await browser.get('/login');
            const url = new URL(response.location ?? '');

            expect(response.status).toBe(303);
            expect(`${url.origin}${url.pathname}`).toBe(
                'http://localhost:4000/authorize',
            );
            expect(url.searchParams.get('response_type')).toBe('code');
            expect(url.searchParams.get('client_id')).toBe('memoboard');
            expect(url.searchParams.get('redirect_uri')).toBe(
                'http://localhost:4001/callback',
            );
            expect(url.searchParams.get('scope')).toBe('read write');
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            expect(url.searchParams.get('state')).toMatch(
                /^[A-Za-z0-9_-]{43}$/,
            );
        });

        it('AS から戻ると、設定のトークンエンドポイントに、トークンの引き換えを送る(Basic 認証、code、redirect_uri)', async () => {
            const { callback } = await login(browser, 'the-code');

            expect(callback.status).toBe(303);
            expect(callback.location).toBe('/');
            expect(backends.tokenRequests).toHaveLength(1);
            const request = backends.tokenRequests[0];
            const expectedBasic = Buffer.from(
                `memoboard:${CLIENT_SECRET}`,
            ).toString('base64');
            expect(request?.method).toBe('POST');
            expect(request?.headers.authorization).toBe(
                `Basic ${expectedBasic}`,
            );
            const form = new URLSearchParams(request?.body);
            expect(form.get('grant_type')).toBe('authorization_code');
            expect(form.get('code')).toBe('the-code');
            expect(form.get('redirect_uri')).toBe(
                'http://localhost:4001/callback',
            );
        });

        it('redirect_uri は、設定の値(認可リクエストと、トークンの引き換えで、同じ値を使う)', async () => {
            const custom = await start({
                redirectUri: 'http://localhost:4001/cb-custom',
            });
            try {
                const who = createClient(custom.baseUrl);

                const { authorize } = await login(who);

                expect(authorize.searchParams.get('redirect_uri')).toBe(
                    'http://localhost:4001/cb-custom',
                );
                const form = new URLSearchParams(
                    backends.tokenRequests[0]?.body,
                );
                expect(form.get('redirect_uri')).toBe(
                    'http://localhost:4001/cb-custom',
                );
            } finally {
                await custom.close();
            }
        });

        it('引き換えに送った code_verifier は、認可リクエストの code_challenge の元(PKCE が、最初から最後まで、つながっている)', async () => {
            const { authorize } = await login();

            const form = new URLSearchParams(backends.tokenRequests[0]?.body);
            const verifier = form.get('code_verifier') ?? '';
            const challenge = createHash('sha256')
                .update(verifier)
                .digest('base64url');

            expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(authorize.searchParams.get('code_challenge')).toBe(
                challenge,
            );
        });

        it('ログインしたあとの / は、RS から取った、メモの一覧。RS には、アクセストークンつきで呼ぶ', async () => {
            seedMemos('牛乳を買う', 'レポートを書く');
            await login();

            const response = await browser.get('/');

            expect(response.status).toBe(200);
            expect(response.text).toContain('牛乳を買う');
            expect(response.text).toContain('レポートを書く');
            expect(response.text).not.toContain(FAKE_ACCESS_TOKEN);
            const listCall = backends.rsRequests.at(-1);
            expect(listCall?.method).toBe('GET');
            expect(listCall?.url).toBe('/memos');
            expect(listCall?.headers.authorization).toBe(
                `Bearer ${FAKE_ACCESS_TOKEN}`,
            );
        });

        it('画面から、メモを作って、見て、直して、消せる(RS の中身も、その通りに変わる)', async () => {
            await login();
            const list = await browser.get('/');
            const csrf = csrfOf(list.text);

            // 作る
            const created = await browser.postForm('/', {
                _csrf: csrf,
                body: '最初のメモ',
            });
            expect(created.status).toBe(303);
            expect(created.location).toBe('/');
            expect(backends.memos.map((m) => m.body)).toEqual(['最初のメモ']);
            const id = backends.memos[0]?.id ?? '';

            // 一覧で見える。詳細へのリンクがある
            const afterCreate = await browser.get('/');
            expect(afterCreate.text).toContain('最初のメモ');
            expect(afterCreate.text).toContain(`href="/detail/${id}"`);

            // 詳細を開く
            const detail = await browser.get(`/detail/${id}`);
            expect(detail.status).toBe(200);
            expect(detail.text).toContain('最初のメモ');

            // 直す
            const updated = await browser.postForm(`/detail/${id}`, {
                _csrf: csrf,
                action: 'update',
                body: '直したメモ',
            });
            expect(updated.status).toBe(303);
            expect(updated.location).toBe(`/detail/${id}`);
            expect(backends.memos.map((m) => m.body)).toEqual(['直したメモ']);

            // 消す
            const removed = await browser.postForm(`/detail/${id}`, {
                _csrf: csrf,
                action: 'delete',
            });
            expect(removed.status).toBe(303);
            expect(removed.location).toBe('/');
            expect(backends.memos).toEqual([]);
            expect((await browser.get(`/detail/${id}`)).status).toBe(404);
        });

        it('検索できる(全角と半角を区別しない)', async () => {
            seedMemos('Buy Milk', '牛乳を買う');
            await login();

            const response = await browser.get(
                `/?q=${encodeURIComponent('ＭＩＬＫ')}`,
            );

            expect(response.text).toContain('Buy Milk');
            expect(response.text).not.toContain('牛乳を買う');
        });

        it('一覧は、更新が新しい順', async () => {
            seedMemos('古いメモ', '新しいメモ');
            await login();

            const response = await browser.get('/');

            expect(response.text.indexOf('新しいメモ')).toBeGreaterThan(-1);
            expect(response.text.indexOf('新しいメモ')).toBeLessThan(
                response.text.indexOf('古いメモ'),
            );
        });

        it('ログアウトすると、ログイン前の画面に戻る。古い Cookie では、もう一覧が見えない', async () => {
            seedMemos('見えるはずのメモ');
            await login();
            const list = await browser.get('/');
            const oldCookie = browser.cookies.get(SESSION_COOKIE_NAME) ?? '';

            const loggedOut = await browser.postForm('/logout', {
                _csrf: csrfOf(list.text),
            });
            const top = await browser.get('/');

            expect(loggedOut.status).toBe(303);
            expect(loggedOut.location).toBe('/');
            expect(top.text).toContain('href="/login"');
            expect(top.text).not.toContain('見えるはずのメモ');

            const stolen = createClient(server.baseUrl);
            stolen.cookies.set(SESSION_COOKIE_NAME, oldCookie);
            const rsCallsBefore = backends.rsRequests.length;
            const viaOldCookie = await stolen.get('/');
            expect(viaOldCookie.text).toContain('href="/login"');
            expect(viaOldCookie.text).not.toContain('見えるはずのメモ');
            expect(backends.rsRequests).toHaveLength(rsCallsBefore);
        });

        it('ログアウトのあと、もう一度ログインできる', async () => {
            seedMemos('メモ');
            await login();
            const list = await browser.get('/');
            await browser.postForm('/logout', { _csrf: csrfOf(list.text) });

            await login(browser, 'code-2');
            const again = await browser.get('/');

            expect(again.status).toBe(200);
            expect(again.text).toContain('メモ');
            expect(backends.tokenRequests).toHaveLength(2);
        });
    });

    describe('ブラウザごとに、別々', () => {
        it('ログインしていないブラウザには、別のブラウザのログインは、見えない', async () => {
            seedMemos('私のメモ');
            await login();
            const stranger = createClient(server.baseUrl);

            const mine = await browser.get('/');
            const theirs = await stranger.get('/');

            expect(mine.text).toContain('私のメモ');
            expect(theirs.text).toContain('href="/login"');
            expect(theirs.text).not.toContain('私のメモ');
        });

        it('別のブラウザの CSRF トークンでは、操作できない', async () => {
            await login();
            const other = createClient(server.baseUrl);
            await login(other, 'code-2');
            const othersList = await other.get('/');

            const response = await browser.postForm('/', {
                _csrf: csrfOf(othersList.text),
                body: 'なりすまし',
            });

            expect(response.status).toBe(403);
            expect(backends.memos).toEqual([]);
        });

        it('別のブラウザの state では、ログインできない(攻撃者の code を、被害者に踏ませても)', async () => {
            const attacker = createClient(server.baseUrl);
            const { authorize } = await login(attacker);
            await browser.get('/login');

            const response = await browser.get(
                `/callback?${new URLSearchParams({
                    code: 'attackers-code',
                    state: authorize.searchParams.get('state') ?? '',
                })}`,
            );

            expect(response.status).toBe(400);
            // 攻撃者自身の引き換えの 1 回だけ。被害者の分は、AS へ送られていない
            expect(backends.tokenRequests).toHaveLength(1);
            expect((await browser.get('/')).text).toContain('href="/login"');
        });
    });

    describe('RS や AS が失敗した時', () => {
        it('RS が 500 を返したら、502 のエラー画面。ログインは、そのまま', async () => {
            await login();
            backends.setRsFailure(500);

            const response = await browser.get('/');
            backends.setRsFailure(undefined);

            expect(response.status).toBe(502);
            expect(response.text).toContain('id="message"');
            expect((await browser.get('/')).status).toBe(200);
        });

        it('RS が 401 を返したら(トークンが使えない)、ログイン前の画面に戻る', async () => {
            await login();
            backends.setRsFailure(401);

            const response = await browser.get('/');
            backends.setRsFailure(undefined);
            const top = await browser.get('/');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
            expect(top.text).toContain('href="/login"');
            expect(top.text).toContain('role="status"');
        });

        it('RS に繋がらなくても、502 のエラー画面(中身は、出さない)', async () => {
            const dead = await start({ rsBaseUrl: DEAD_URL });
            try {
                const who = createClient(dead.baseUrl);
                await login(who);

                const response = await who.get('/');

                expect(response.status).toBe(502);
                expect(response.text).not.toContain('127.0.0.1');
                expect(response.text).not.toContain('ECONNREFUSED');
            } finally {
                await dead.close();
            }
        });

        it('AS が、引き換えを断ったら(invalid_grant)、400 のエラー画面。ログインしない', async () => {
            backends.setTokenResponse({
                status: 400,
                body: { error: 'invalid_grant' },
            });

            const { callback } = await login();

            expect(callback.status).toBe(400);
            expect((await browser.get('/')).text).toContain('href="/login"');
        });

        it('AS に繋がらなくても、502 のエラー画面。ログインしない', async () => {
            const dead = await start({ tokenEndpoint: `${DEAD_URL}/token` });
            try {
                const who = createClient(dead.baseUrl);

                const { callback } = await login(who);

                expect(callback.status).toBe(502);
                expect(callback.text).not.toContain('127.0.0.1');
                expect((await who.get('/')).text).toContain('href="/login"');
            } finally {
                await dead.close();
            }
        });

        it('AS が、おかしな返事(アクセストークンが無い)を返したら、502。ログインしない', async () => {
            backends.setTokenResponse({
                status: 200,
                body: { token_type: 'Bearer' },
            });

            const { callback } = await login();

            expect(callback.status).toBe(502);
            expect((await browser.get('/')).text).toContain('href="/login"');
        });
    });

    describe('セキュリティヘッダー(全部の画面に付く)', () => {
        const expectSecurityHeaders = (headers: Headers) => {
            const csp = headers.get('content-security-policy') ?? '';
            expect(csp).toContain("default-src 'self'");
            expect(csp).toContain("frame-ancestors 'none'");
            expect(headers.get('x-frame-options')).toBe('DENY');
            expect(headers.get('x-content-type-options')).toBe('nosniff');
            expect(headers.get('referrer-policy')).toBe('no-referrer');
            expect(headers.has('x-powered-by')).toBe(false);
        };

        it.each([
            { name: 'ログイン前の画面', path: '/' },
            { name: '認可リクエストへのリダイレクト', path: '/login' },
            { name: '404 のエラー画面', path: '/nothing-here' },
            {
                name: '400 のエラー画面(callback の state 違い)',
                path: '/callback',
            },
        ])('$name', async ({ path }) => {
            const response = await browser.get(path);

            expectSecurityHeaders(response.headers);
        });

        it('ログイン後の、一覧と詳細にも付く', async () => {
            seedMemos('メモ');
            await login();

            const list = await browser.get('/');
            const detail = await browser.get('/detail/s1');

            expect(list.status).toBe(200);
            expect(detail.status).toBe(200);
            expectSecurityHeaders(list.headers);
            expectSecurityHeaders(detail.headers);
        });

        it('403 のエラー画面にも付く', async () => {
            const response = await browser.postForm('/logout', {});

            expect(response.status).toBe(403);
            expectSecurityHeaders(response.headers);
        });
    });

    describe('セッションの Cookie', () => {
        it('名前は memoboard_sid(AS の Cookie と、ぶつからない)。HttpOnly と SameSite=Lax。http の BASE_URL なので、Secure は付けない', async () => {
            const response = await browser.get('/login');

            const [cookie = ''] = response.headers.getSetCookie();
            expect(cookie).toMatch(/^memoboard_sid=/);
            expect(cookie).toContain('HttpOnly');
            expect(cookie).toContain('SameSite=Lax');
            expect(cookie).not.toContain('Secure');
            expect(cookie).not.toMatch(/^as_sid=/);
        });

        it('Cookie の署名は、設定の SESSION_SECRET で作る(別の秘密で署名した Cookie は、受け付けない)', async () => {
            await login();
            const cookieValue = decodeURIComponent(
                browser.cookies.get(SESSION_COOKIE_NAME) ?? '',
            );
            // s:<セッション ID>.<署名>
            const sessionId = cookieValue.slice(
                2,
                cookieValue.lastIndexOf('.'),
            );
            seedMemos('メモ');

            const withRightSecret = createClient(server.baseUrl);
            withRightSecret.cookies.set(
                SESSION_COOKIE_NAME,
                signedCookie(sessionId, SESSION_SECRET),
            );
            const withWrongSecret = createClient(server.baseUrl);
            withWrongSecret.cookies.set(
                SESSION_COOKIE_NAME,
                signedCookie(sessionId, 'x'.repeat(32)),
            );

            expect((await withRightSecret.get('/')).text).toContain('メモ');
            expect((await withWrongSecret.get('/')).text).toContain(
                'href="/login"',
            );
        });

        it('BASE_URL が https なら、Secure 付きの Cookie を要求する(http のまま来ると、Cookie が出ない)', async () => {
            const secure = await start({
                baseUrl: 'https://board.example.com',
                redirectUri: 'https://board.example.com/callback',
            });
            try {
                const who = createClient(secure.baseUrl);

                const response = await who.get('/login');

                expect(response.status).toBe(303);
                expect(response.headers.getSetCookie()).toEqual([]);
            } finally {
                await secure.close();
            }
        });
    });

    describe('道と、エラー', () => {
        it('ルートが無い道は、404 のエラー画面(HTML)', async () => {
            const response = await browser.get('/nothing-here');

            expect(response.status).toBe(404);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.text).toContain('id="message"');
        });

        it.each([
            '/detail',
            '/detail/',
            '/detail/a/b',
            '/callback/x',
            '/logout/x',
        ])('%s は、404', async (path) => {
            await login();

            const response = await browser.get(path);

            expect(response.status).toBe(404);
        });

        it('壊れた %XX の道は、この app の 400 のエラー画面(ヘッダー付き)', async () => {
            await login();

            const response = await browser.get('/detail/%E0%A4%A');

            expect(response.status).toBe(400);
            expect(response.text).toContain('id="message"');
            expect(response.headers.get('x-frame-options')).toBe('DENY');
        });

        it('大きすぎるフォーム(200KB)は、この app の 413 のエラー画面(ヘッダー付き)', async () => {
            await login();
            const cookie = [...browser.cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join('; ');

            const response = await fetch(`${server.baseUrl}/`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Cookie: cookie,
                },
                body: `body=${'a'.repeat(200_000)}`,
            });
            const text = await response.text();

            expect(response.status).toBe(413);
            expect(text).toContain('id="message"');
            expect(response.headers.get('x-frame-options')).toBe('DENY');
        });

        it('GET 専用の道(/login、/callback)に POST すると、405', async () => {
            expect((await browser.postForm('/login', {})).status).toBe(405);
            expect((await browser.postForm('/callback', {})).status).toBe(405);
        });

        it('POST 専用の道(/logout)に GET すると、405', async () => {
            expect((await browser.get('/logout')).status).toBe(405);
        });
    });

    describe('時計(トークンの期限)', () => {
        it('アクセストークンの期限が過ぎたら、ログイン前の画面に戻って、RS を呼ばない', async () => {
            // トークンの有効は 600 秒。1000 秒後にする
            clock = () => Math.floor(Date.now() / 1000) + 1000;
            const late = await start();
            try {
                const who = createClient(late.baseUrl);
                await login(who, 'code-2');
                // 引き換えは、時計に関わらず、成功する。期限は、今の時計から見て、切れている
                const rsCallsBefore = backends.rsRequests.length;

                const top = await who.get('/');

                expect(top.status).toBe(200);
                expect(top.text).toContain('href="/login"');
                expect(backends.rsRequests).toHaveLength(rsCallsBefore);
            } finally {
                await late.close();
            }
        });

        it('期限が切れたトークンが残っていても、/login は、新しくログインを始める', async () => {
            clock = () => Math.floor(Date.now() / 1000) + 1000;
            const late = await start();
            try {
                const who = createClient(late.baseUrl);
                await login(who);

                const response = await who.get('/login');

                expect(response.status).toBe(303);
                expect(response.location).toContain(
                    'http://localhost:4000/authorize',
                );
            } finally {
                await late.close();
            }
        });

        it('期限が切れたトークンでは、メモの画面(/detail/:id)も、/ へ戻して、RS を呼ばない', async () => {
            seedMemos('メモ');
            clock = () => Math.floor(Date.now() / 1000) + 1000;
            const late = await start();
            try {
                const who = createClient(late.baseUrl);
                await login(who);
                const rsCallsBefore = backends.rsRequests.length;

                const response = await who.get('/detail/s1');

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                expect(backends.rsRequests).toHaveLength(rsCallsBefore);
            } finally {
                await late.close();
            }
        });

        it('期限の前なら、そのまま使える(時計を進めない)', async () => {
            seedMemos('メモ');
            await login();

            const response = await browser.get('/');

            expect(response.text).toContain('メモ');
        });
    });
});
