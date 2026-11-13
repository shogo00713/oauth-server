import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthzRequest } from '../lib/authz-request.js';
import { sha256Hex } from '../lib/hash.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import type { Client } from '../stores/client-store.js';
import { createMemoryClientStore } from '../stores/memory-client-store.js';
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
import { createLoginRouter, type LoginDeps } from './login.js';

// hashPassword と verifyPassword を、本物のまま動かして、呼ばれた回数と引数を、あとで見られるようにする
vi.mock('../lib/password.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../lib/password.js')>();
    return {
        ...actual,
        hashPassword: vi.fn(actual.hashPassword),
        verifyPassword: vi.fn(actual.verifyPassword),
    };
});

const PASSWORD = 'correct horse battery';
// 軽いコスト(テストを速くするため)
const FAST = { memoryCost: 1024, timeCost: 2, parallelism: 1 };
const REDIRECT_URI = 'http://localhost:3000/callback';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

// ログイン画面の前に、/authorize が取っておいたはずの、認可リクエスト
const PENDING: AuthzRequest = {
    clientId: 'memoboard',
    redirectUri: REDIRECT_URI,
    scope: ['read'],
    state: 'xyz',
    codeChallenge: CODE_CHALLENGE,
};

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
];

let alice: User;
let server: TestServer;
let client: TestClient;
let consoleError: ReturnType<typeof vi.spyOn>;

const makeDeps = (): LoginDeps => ({
    clientStore: createMemoryClientStore(clients),
    userStore: createMemoryUserStore([alice]),
});

const start = async (deps: LoginDeps) => {
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: 認可リクエストを取っておいたことにする / 消す
            app.get('/__test/pending', (req, res) => {
                req.session.pending = {
                    ...PENDING,
                    clientId: String(req.query['client'] ?? PENDING.clientId),
                };
                res.send('ok');
            });
            app.get('/__test/clear-pending', (req, res) => {
                delete req.session.pending;
                res.send('ok');
            });
            app.use('/login', createLoginRouter(deps));
        }),
    );
    client = createClient(server.baseUrl);
};

// 別の設定で、起動し直す
const restart = async (deps: LoginDeps) => {
    await server.close();
    await start(deps);
};

beforeEach(async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(verifyPassword).mockClear();
    alice = {
        id: TEST_USER_ID,
        username: 'alice',
        passwordHash: await hashPassword(PASSWORD, FAST),
    };
    await start(makeDeps());
    vi.mocked(hashPassword).mockClear();
});

afterEach(async () => {
    await server.close();
    consoleError.mockRestore();
});

// 画面の HTML から、フォームの CSRF トークンを取り出す
const csrfOf = (html: string): string =>
    /<input[^>]*name="_csrf"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '';

// 画面の HTML から、エラーの表示(role="alert")の言葉を取り出す
const alertOf = (html: string): string | null =>
    /<p[^>]*role="alert"[^>]*>([^<]*)<\/p>/.exec(html)?.[1]?.trim() ?? null;

// 認可リクエストを取っておいて、ログイン画面を開く
const openLogin = async (clientId?: string) => {
    await client.get(
        clientId ? `/__test/pending?client=${clientId}` : '/__test/pending',
    );
    const response = await client.get('/login');
    return { response, csrf: csrfOf(response.text) };
};

const fields = (csrf: string, overrides: Record<string, string> = {}) => ({
    username: 'alice',
    password: PASSWORD,
    _csrf: csrf,
    ...overrides,
});

// ブラウザと同じ手順で、ログインする(画面を開いて、フォームを送る)
const login = async (overrides: Record<string, string> = {}) => {
    const { csrf } = await openLogin();
    return client.postForm('/login', fields(csrf, overrides));
};

// フォームの本文を、そのまま送る(同じ名前を 2 回、などを試すため)。client の Cookie を付ける
const rawPost = async (
    body: string,
    contentType = 'application/x-www-form-urlencoded',
) => {
    const cookie = [...client.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    const response = await fetch(`${server.baseUrl}/login`, {
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
        headers: response.headers,
    };
};

describe('LOGIN ログイン /login OWASP Authentication / Session Management', () => {
    describe('GET /login(ログイン画面)', () => {
        it('認可リクエストがあれば、ログイン画面(HTML)を返す', async () => {
            const { response } = await openLogin();

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        });

        it('フォームは、/login に POST する。ユーザー名とパスワードの欄がある', async () => {
            const { response } = await openLogin();

            expect(response.text).toMatch(
                /<form[^>]*method="post"[^>]*action="\/login"/,
            );
            expect(response.text).toMatch(
                /<input[^>]*type="text"[^>]*name="username"/,
            );
            expect(response.text).toMatch(
                /<input[^>]*type="password"[^>]*name="password"/,
            );
        });

        it('どのアプリがログインを求めているか、画面に出す', async () => {
            const { response } = await openLogin();

            expect(response.text).toContain('メモボード');
        });

        it('アプリの名前の中の HTML は、エスケープして出す', async () => {
            const { response } = await openLogin('xss-app');

            expect(response.text).toContain('&lt;script&gt;alert(1)');
            expect(response.text).not.toContain('<script>alert(1)');
        });

        it('フォームに CSRF トークンを入れて、同じ物を、セッションにも入れる', async () => {
            const { csrf } = await openLogin();

            expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect((await readSession(client)).csrfToken).toBe(csrf);
        });

        it('開き直しても、同じトークン', async () => {
            const first = await openLogin();
            const second = await client.get('/login');

            expect(csrfOf(second.text)).toBe(first.csrf);
        });

        it('最初は、エラーの表示も、入力済みのユーザー名も無い', async () => {
            const { response } = await openLogin();

            expect(alertOf(response.text)).toBeNull();
            expect(response.text).toMatch(/name="username"[^>]*value=""/);
        });

        it('取っておいた認可リクエストには、触らない', async () => {
            await openLogin();

            expect((await readSession(client)).pending).toEqual(PENDING);
        });

        it('認可リクエストが無ければ、400 のエラー画面(Cookie も出さない)', async () => {
            const response = await client.get('/login');

            expect(response.status).toBe(400);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(client.cookies.size).toBe(0);
        });

        it('ログイン済みで、認可リクエストがあれば、/consent に 303', async () => {
            await client.get('/__test/login');
            await client.get('/__test/pending');

            const response = await client.get('/login');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/consent');
        });

        it('ログイン済みでも、認可リクエストが無ければ、400 のエラー画面', async () => {
            await client.get('/__test/login');

            const response = await client.get('/login');

            expect(response.status).toBe(400);
        });

        it('取っておいた client_id が、名簿に無ければ、400 のエラー画面', async () => {
            await client.get('/__test/pending?client=gone-app');

            const response = await client.get('/login');

            expect(response.status).toBe(400);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
        });
    });

    describe('POST /login: ログインできる', () => {
        it('正しいユーザー名とパスワードなら、/consent に 303', async () => {
            const response = await login();

            expect(response.status).toBe(303);
            expect(response.location).toBe('/consent');
        });

        it('セッションに userId が入って、取っておいた認可リクエストも、残る', async () => {
            await login();

            const session = await readSession(client);
            expect(session.userId).toBe(alice.id);
            expect(session.pending).toEqual(PENDING);
        });

        it('セッション ID を作り直す(セッション固定化攻撃の対策)', async () => {
            const { csrf } = await openLogin();
            const before = client.cookies.get('as_sid');

            await client.postForm('/login', fields(csrf));

            const after = client.cookies.get('as_sid');
            expect(before).toBeTruthy();
            expect(after).toBeTruthy();
            expect(after).not.toBe(before);
        });

        it('新しい Cookie を 1 本だけ出す', async () => {
            const { csrf } = await openLogin();

            const response = await client.postForm('/login', fields(csrf));

            expect(response.headers.getSetCookie()).toHaveLength(1);
            expect(response.headers.getSetCookie()[0]).toMatch(/^as_sid=/);
        });

        it('古いセッション ID は、もう使えない(ログインの記録も、取っておいた物も、見えない)', async () => {
            const { csrf } = await openLogin();
            const oldCookie = client.cookies.get('as_sid') ?? '';
            await client.postForm('/login', fields(csrf));

            const attacker = createClient(server.baseUrl);
            attacker.cookies.set('as_sid', oldCookie);

            expect(await readSession(attacker)).toMatchObject({
                userId: null,
                pending: null,
            });
            // 比べるために、新しい Cookie の方は、ログインの記録が見えること
            expect((await readSession(client)).userId).toBe(alice.id);
        });

        it('ログインしたあとに、/login を開くと、/consent に 303', async () => {
            await login();

            const response = await client.get('/login');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/consent');
        });
    });

    describe('POST /login: ログインできない', () => {
        const failures = [
            { name: 'パスワードが違う', overrides: { password: 'wrong' } },
            {
                name: 'パスワードの大文字小文字が違う',
                overrides: { password: PASSWORD.toUpperCase() },
            },
            { name: 'パスワードが空', overrides: { password: '' } },
            { name: 'ユーザー名が居ない', overrides: { username: 'nobody' } },
            {
                name: 'ユーザー名の大文字小文字が違う',
                overrides: { username: 'ALICE' },
            },
            {
                name: 'ユーザー名の前に空白がある',
                overrides: { username: ' alice' },
            },
            { name: 'ユーザー名が空', overrides: { username: '' } },
        ];

        it.each(failures)(
            '200 で、ログイン画面をもう一度出して、エラーを知らせる: $name',
            async ({ overrides }) => {
                const response = await login(overrides);

                expect(response.status).toBe(200);
                expect(response.headers.get('content-type')).toMatch(
                    /^text\/html/,
                );
                expect(response.location).toBeNull();
                expect(alertOf(response.text)).toBeTruthy();
                expect(response.text).toMatch(/<form[^>]*action="\/login"/);
            },
        );

        it.each(failures)(
            'ログインの記録は残らない。セッション ID も変えない。認可リクエストも残る: $name',
            async ({ overrides }) => {
                const { csrf } = await openLogin();
                const before = client.cookies.get('as_sid');

                const response = await client.postForm(
                    '/login',
                    fields(csrf, overrides),
                );

                expect(response.status).toBe(200);
                expect(response.headers.getSetCookie()).toEqual([]);
                expect(client.cookies.get('as_sid')).toBe(before);
                expect(await readSession(client)).toMatchObject({
                    userId: null,
                    pending: PENDING,
                });
            },
        );

        it('ユーザー名が居ない時と、パスワードが違う時で、status も言葉も同じ(どちらが違うか、分からない)', async () => {
            const { csrf } = await openLogin();

            const wrongPassword = await client.postForm(
                '/login',
                fields(csrf, { password: 'wrong' }),
            );
            const unknownUser = await client.postForm(
                '/login',
                fields(csrf, { username: 'nobody' }),
            );

            expect(unknownUser.status).toBe(wrongPassword.status);
            expect(alertOf(wrongPassword.text)).toBeTruthy();
            expect(alertOf(unknownUser.text)).toBe(alertOf(wrongPassword.text));
        });

        it('失敗の画面にも、どのアプリがログインを求めているか、出す', async () => {
            const response = await login({ password: 'wrong' });

            expect(response.text).toContain('メモボード');
        });

        it('すでにログイン済みの人が、間違えて送っても、ログインの記録は消えない', async () => {
            const { csrf } = await openLogin();
            await client.get('/__test/login');

            const response = await client.postForm(
                '/login',
                fields(csrf, { password: 'wrong' }),
            );

            expect(response.status).toBe(200);
            expect((await readSession(client)).userId).toBe(TEST_USER_ID);
        });

        it('入力したユーザー名は、画面に戻す', async () => {
            const response = await login({ password: 'wrong' });

            expect(response.text).toMatch(/name="username"[^>]*value="alice"/);
        });

        it('戻すユーザー名の中の HTML は、エスケープする', async () => {
            const response = await login({
                username: '"><script>alert(1)</script>',
            });

            expect(response.text).not.toContain('<script>alert(1)');
            expect(response.text).toContain('&lt;script&gt;alert(1)');
        });

        it('入力したパスワードは、画面に出さない', async () => {
            const response = await login({ password: 'my-secret-pass-123' });

            expect(response.text).not.toContain('my-secret-pass-123');
        });

        it('フォームのトークンは、失敗のあとも、そのまま使える', async () => {
            const { csrf } = await openLogin();
            const failed = await client.postForm(
                '/login',
                fields(csrf, { password: 'wrong' }),
            );

            expect(csrfOf(failed.text)).toBe(csrf);

            const retry = await client.postForm('/login', fields(csrf));
            expect(retry.status).toBe(303);
            expect(retry.location).toBe('/consent');
        });

        describe('フォームの項目が、足りない・2 回ある時も、同じ失敗の画面(500 にならない)', () => {
            const cases = [
                {
                    name: 'username が無い',
                    body: (c: string) => `_csrf=${c}&password=${PASSWORD}`,
                },
                {
                    name: 'password が無い',
                    body: (c: string) => `_csrf=${c}&username=alice`,
                },
                { name: 'どちらも無い', body: (c: string) => `_csrf=${c}` },
                {
                    name: 'username が 2 回ある',
                    body: (c: string) =>
                        `_csrf=${c}&username=alice&username=bob&password=${PASSWORD}`,
                },
                {
                    name: 'password が 2 回ある',
                    body: (c: string) =>
                        `_csrf=${c}&username=alice&password=${PASSWORD}&password=${PASSWORD}`,
                },
            ];

            it.each(cases)('$name', async ({ body }) => {
                const { csrf } = await openLogin();

                const response = await rawPost(body(csrf));

                expect(response.status).toBe(200);
                expect(alertOf(response.text)).toBeTruthy();
                expect((await readSession(client)).userId).toBeNull();
            });
        });
    });

    describe('POST /login: 処理時間を揃える(存在しない username でも、ハッシュの確認を走らせる)', () => {
        it('存在しない username でも、verifyPassword を 1 回呼ぶ(ダミーのハッシュで)', async () => {
            await login({ username: 'nobody', password: 'some-password' });

            expect(verifyPassword).toHaveBeenCalledTimes(1);
            expect(verifyPassword).toHaveBeenCalledWith(
                'some-password',
                expect.stringMatching(/^\$argon2id\$/),
            );
        });

        it('ダミーのハッシュは、本物と同じ重さ(既定のコスト m=65536、t=3、p=4)', async () => {
            await login({ username: 'nobody' });

            const hash = String(vi.mocked(verifyPassword).mock.calls[0]?.[1]);
            expect(hash).toContain('m=65536');
            expect(hash).toContain('t=3');
            expect(hash).toContain('p=4');
        });

        it('存在しない username を、続けて 2 回試しても、どちらも失敗の画面', async () => {
            const { csrf } = await openLogin();

            const first = await client.postForm(
                '/login',
                fields(csrf, { username: 'nobody' }),
            );
            const second = await client.postForm(
                '/login',
                fields(csrf, { username: 'someone-else' }),
            );

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(verifyPassword).toHaveBeenCalledTimes(2);
        });

        it('存在しない username を続けて 2 回試しても、ダミーのハッシュは、作り直さない(1 回以下)', async () => {
            const { csrf } = await openLogin();

            await client.postForm(
                '/login',
                fields(csrf, { username: 'nobody' }),
            );
            await client.postForm(
                '/login',
                fields(csrf, { username: 'someone-else' }),
            );

            // 作り直すと、存在しない時だけ、処理が 2 倍重くなって、時間の差を、逆に作ってしまう
            expect(
                vi.mocked(hashPassword).mock.calls.length,
            ).toBeLessThanOrEqual(1);
        });

        it('ユーザーが居る時は、ダミーのハッシュを、作らない', async () => {
            await login({ password: 'wrong-password' });
            await login();

            expect(hashPassword).not.toHaveBeenCalled();
        });

        it('ユーザーが居て、パスワードが違う時は、そのユーザーのハッシュで 1 回', async () => {
            await login({ password: 'wrong-password' });

            expect(verifyPassword).toHaveBeenCalledTimes(1);
            expect(verifyPassword).toHaveBeenCalledWith(
                'wrong-password',
                alice.passwordHash,
            );
        });

        it('正しい時も、1 回', async () => {
            const response = await login();

            expect(response.status).toBe(303);
            expect(verifyPassword).toHaveBeenCalledTimes(1);
            expect(verifyPassword).toHaveBeenCalledWith(
                PASSWORD,
                alice.passwordHash,
            );
        });

        it('CSRF が違う時は、呼ばない(重い処理を、無駄に走らせない)', async () => {
            await openLogin();

            await client.postForm('/login', fields('wrong-token'));

            expect(verifyPassword).not.toHaveBeenCalled();
        });

        it('認可リクエストが無い時は、呼ばない', async () => {
            const { csrf } = await openLogin();
            await client.get('/__test/clear-pending');

            await client.postForm('/login', fields(csrf));

            expect(verifyPassword).not.toHaveBeenCalled();
        });
    });

    describe('POST /login: CSRF(RFC 6749 10.12: AS は、認可エンドポイントに CSRF 対策をしなければならない)', () => {
        it.each([
            {
                name: '_csrf が無い',
                overrides: undefined,
                fieldsOf: (_csrf: string) => ({
                    username: 'alice',
                    password: PASSWORD,
                }),
            },
            {
                name: '_csrf が違う',
                overrides: undefined,
                fieldsOf: (_csrf: string) => fields('wrong-token'),
            },
            {
                name: '_csrf が空',
                overrides: undefined,
                fieldsOf: (_csrf: string) => fields(''),
            },
        ])(
            '403 のエラー画面で、ログインさせない: $name',
            async ({ fieldsOf }) => {
                const { csrf } = await openLogin();
                const before = client.cookies.get('as_sid');

                const response = await client.postForm(
                    '/login',
                    fieldsOf(csrf),
                );

                expect(response.status).toBe(403);
                expect(response.headers.get('content-type')).toMatch(
                    /^text\/html/,
                );
                expect(response.location).toBeNull();
                // パスワードは合っているのに、ログインしてない。セッションも変えない
                expect(client.cookies.get('as_sid')).toBe(before);
                expect(await readSession(client)).toMatchObject({
                    userId: null,
                    pending: PENDING,
                });
            },
        );

        it('_csrf が 2 回ある時も、403', async () => {
            const { csrf } = await openLogin();

            const response = await rawPost(
                `_csrf=${csrf}&_csrf=${csrf}&username=alice&password=${PASSWORD}`,
            );

            expect(response.status).toBe(403);
            expect((await readSession(client)).userId).toBeNull();
        });

        it('セッションが無い(Cookie が無い)まま、トークンだけ付けて送っても、403', async () => {
            const { csrf } = await openLogin();
            const stranger = createClient(server.baseUrl);

            const response = await stranger.postForm('/login', fields(csrf));

            expect(response.status).toBe(403);
            expect(stranger.cookies.size).toBe(0);
        });

        it('別の人(別のセッション)のトークンでは、403', async () => {
            const { csrf: aliceToken } = await openLogin();
            const other = createClient(server.baseUrl);
            await other.get('/__test/pending');
            await other.get('/login');

            const response = await other.postForm('/login', fields(aliceToken));

            expect(response.status).toBe(403);
            expect((await readSession(other)).userId).toBeNull();
        });

        it('フォームの形式じゃない本文(JSON)でも、500 にならず 403', async () => {
            const { csrf } = await openLogin();

            const response = await rawPost(
                JSON.stringify(fields(csrf)),
                'application/json',
            );

            expect(response.status).toBe(403);
            expect((await readSession(client)).userId).toBeNull();
        });

        it('本文が無くても、500 にならず 403', async () => {
            await openLogin();

            const response = await rawPost('');

            expect(response.status).toBe(403);
        });

        it('403 の画面に、入力したユーザー名は出さない', async () => {
            await openLogin();

            const response = await client.postForm(
                '/login',
                fields('wrong-token', { username: 'secret-user-name' }),
            );

            expect(response.status).toBe(403);
            expect(response.text).not.toContain('secret-user-name');
        });
    });

    describe('POST /login: 認可リクエストが無い時', () => {
        it('CSRF が合っていても、取っておいた物が無ければ、400 で、ログインさせない', async () => {
            const { csrf } = await openLogin();
            await client.get('/__test/clear-pending');

            const response = await client.postForm('/login', fields(csrf));

            expect(response.status).toBe(400);
            expect((await readSession(client)).userId).toBeNull();
        });

        it('取っておいた client_id が、名簿に無ければ、400 で、ログインさせない', async () => {
            // 画面は、正しいアプリで開いて(トークンを作って)、そのあとで、名簿に無いアプリに書き換える
            const { csrf } = await openLogin();
            await client.get('/__test/pending?client=gone-app');

            const response = await client.postForm('/login', fields(csrf));

            expect(response.status).toBe(400);
            expect((await readSession(client)).userId).toBeNull();
        });
    });

    describe('GET と POST 以外のメソッド', () => {
        it.each(['PUT', 'DELETE', 'PATCH'])(
            '%s は、405 で、Allow: GET, POST',
            async (method) => {
                const response = await fetch(`${server.baseUrl}/login`, {
                    method,
                    redirect: 'manual',
                });

                expect(response.status).toBe(405);
                expect(response.headers.get('allow')).toBe('GET, POST');
            },
        );
    });

    describe('中で失敗した時', () => {
        it('ユーザーのストアが失敗したら、500 のエラー画面(中身は出さない)。ログインもさせない', async () => {
            await restart({
                ...makeDeps(),
                userStore: {
                    findByUsername: async () => {
                        throw new Error('USER-STORE-DOWN-DETAIL');
                    },
                    findById: async () => null,
                },
            });

            const response = await login();

            expect(response.status).toBe(500);
            expect(response.text).not.toContain('USER-STORE-DOWN-DETAIL');
            expect(consoleError).toHaveBeenCalledOnce();
            expect((await readSession(client)).userId).toBeNull();
        });

        it('アプリのストアが失敗したら、ログイン画面も、500 のエラー画面(中身は出さない)', async () => {
            await restart({
                ...makeDeps(),
                clientStore: {
                    find: async () => {
                        throw new Error('CLIENT-STORE-DOWN-DETAIL');
                    },
                },
            });
            await client.get('/__test/pending');

            const response = await client.get('/login');

            expect(response.status).toBe(500);
            expect(response.text).not.toContain('CLIENT-STORE-DOWN-DETAIL');
        });
    });

    describe('キャッシュさせない(画面にも、リダイレクトにも)', () => {
        it('ログイン画面(200)', async () => {
            const { response } = await openLogin();

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('ログイン成功のリダイレクト(303)', async () => {
            const response = await login();

            expect(response.status).toBe(303);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('ログイン失敗の画面(200)', async () => {
            const response = await login({ password: 'wrong' });

            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('403 のエラー画面', async () => {
            await openLogin();

            const response = await client.postForm(
                '/login',
                fields('wrong-token'),
            );

            expect(response.status).toBe(403);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('400 のエラー画面', async () => {
            const response = await client.get('/login');

            expect(response.status).toBe(400);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('405', async () => {
            const response = await fetch(`${server.baseUrl}/login`, {
                method: 'PUT',
            });

            expect(response.status).toBe(405);
            expect(response.headers.get('cache-control')).toBe('no-store');
        });
    });
});
