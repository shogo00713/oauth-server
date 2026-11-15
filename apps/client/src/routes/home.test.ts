import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from 'vitest';
import { ensureCsrfToken } from '../lib/csrf.js';
import { SESSION_COOKIE_NAME } from '../lib/session.js';
import type { ApiFailure, Memo, MemoApi } from '../rs/memo-api.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestResponse,
    type TestServer,
} from '../test-utils/http.js';
import {
    createPageTestApp,
    readSession,
    TEST_TOKENS,
} from '../test-utils/page-app.js';
import { createHomeRouter } from './home.js';

const NOW = 1_800_000_000;

// 見た目では、区別しにくい空白。コードの中に直接書かずに、番号で作る
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

const memo = (id: string, body: string, updatedAt: string): Memo => ({
    id,
    body,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt,
});

// RS は、作った順(古い順)で返す
const MEMOS: Memo[] = [
    memo('m1', '牛乳を買う', '2026-11-01T09:00:00.000Z'),
    memo('m2', 'Buy Milk and eggs', '2026-11-02T09:00:00.000Z'),
    memo('m3', 'レポートを書く', '2026-11-03T09:00:00.000Z'),
];

const PAGE_FAILURES: { failure: ApiFailure; status: number }[] = [
    { failure: 'insufficient_scope', status: 403 },
    { failure: 'forbidden', status: 403 },
    { failure: 'not_found', status: 404 },
    { failure: 'invalid_request', status: 400 },
    { failure: 'unavailable', status: 502 },
];

type FakeMemoApi = {
    [K in keyof MemoApi]: Mock<MemoApi[K]>;
};

let server: TestServer;
let client: TestClient;
let memoApi: FakeMemoApi;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    memoApi = {
        list: vi.fn<MemoApi['list']>(async () => ({ ok: true, data: MEMOS })),
        get: vi.fn<MemoApi['get']>(),
        create: vi.fn<MemoApi['create']>(async (_token, body) => ({
            ok: true,
            data: memo('new', body, '2026-11-04T09:00:00.000Z'),
        })),
        update: vi.fn<MemoApi['update']>(),
        delete: vi.fn<MemoApi['delete']>(),
    };
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: 期限つきのトークンで、ログイン済みにする
            app.get('/__test/login-until/:expiresAt', (req, res) => {
                req.session.tokens = {
                    accessToken: 'at-test',
                    expiresAt: Number(req.params['expiresAt']),
                    scope: 'read write',
                };
                res.send('ok');
            });
            // テスト専用の道: CSRF トークンを作って、返す
            app.get('/__test/csrf', (req, res) => {
                res.send(ensureCsrfToken(req.session));
            });
            // テスト専用の道: 次の画面に出すメッセージを、入れる
            app.get('/__test/flash', (req, res) => {
                req.session.flash = String(req.query['text']);
                res.send('ok');
            });
            app.use('/', createHomeRouter({ memoApi, now: () => NOW }));
        }),
    );
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
});

// ログイン済みで、フォームを開いて、そのトークンを返す
const loginAndOpenForm = async (who: TestClient = client) => {
    await who.get('/__test/login');
    return (await who.get('/__test/csrf')).text;
};

const create = (
    token: string,
    body: Record<string, string> = {},
    who: TestClient = client,
) => who.postForm('/', { _csrf: token, ...body });

// フォームの形で、そのまま送る(項目が 2 回ある、などを試すため)
const rawPost = (
    body: string,
    contentType = 'application/x-www-form-urlencoded',
    who: TestClient = client,
) => {
    const cookie = [...who.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    return fetch(`${server.baseUrl}/`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
            'Content-Type': contentType,
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body,
    });
};

const expectErrorPage = (response: TestResponse, status: number) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.text).toContain('<html');
    expect(response.location).toBeNull();
};

// 画面の中で、文字が出てくる位置
const positionsOf = (html: string, texts: string[]) =>
    texts.map((text) => html.indexOf(text));

describe('HOME / ログイン前の画面、メモの一覧、検索、作成', () => {
    describe('GET /: ログインしていない時', () => {
        it('ログインを促す画面(200)を返す。RS は、呼ばない', async () => {
            const response = await client.get('/');

            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.text).toContain('href="/login"');
            expect(response.text).not.toContain('name="_csrf"');
            expect(memoApi.list).not.toHaveBeenCalled();
        });

        it('セッションを持っていない人には、Cookie を出さない', async () => {
            const response = await client.get('/');

            expect(response.headers.getSetCookie()).toEqual([]);
        });

        it('キャッシュさせない', async () => {
            const response = await client.get('/');

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('セッションにメッセージ(flash)があれば、出す。出したら、消える(1 回だけ)', async () => {
            await client.get('/__test/flash?text=ログアウトしました');

            const first = await client.get('/');
            const second = await client.get('/');
            const session = await readSession(client);

            expect(first.text).toContain('ログアウトしました');
            expect(first.text).toContain('role="status"');
            expect(second.text).not.toContain('ログアウトしました');
            expect(second.text).not.toContain('role="status"');
            expect(session.flash).toBeNull();
        });

        it('メッセージの中の HTML は、エスケープして出す', async () => {
            await client.get(
                `/__test/flash?text=${encodeURIComponent('<b>x</b>')}`,
            );

            const response = await client.get('/');

            expect(response.text).toContain('&lt;b&gt;x&lt;/b&gt;');
            expect(response.text).not.toContain('<b>x</b>');
        });

        describe('期限切れのトークンが残っている時', () => {
            it.each([
                { name: '期限切れ', expiresAt: NOW - 1 },
                { name: '期限ちょうど', expiresAt: NOW },
                { name: '期限の 30 秒前(余裕の中)', expiresAt: NOW + 30 },
            ])(
                '$name: ログインを促す画面を返す。メッセージを出す。RS は、呼ばない',
                async ({ expiresAt }) => {
                    await client.get(`/__test/login-until/${expiresAt}`);

                    const response = await client.get('/');

                    expect(response.status).toBe(200);
                    expect(response.text).toContain('href="/login"');
                    expect(response.text).toContain('role="status"');
                    expect(memoApi.list).not.toHaveBeenCalled();
                },
            );

            it('セッションは、捨てられる(トークンが消える。セッション ID が変わる)', async () => {
                await client.get(`/__test/login-until/${NOW - 1}`);
                const before = client.cookies.get(SESSION_COOKIE_NAME);

                await client.get('/');
                const session = await readSession(client);

                expect(session.tokens).toBeNull();
                expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(
                    before,
                );
            });

            it('メッセージは、1 回だけ(次に開いた時は、出ない)', async () => {
                await client.get(`/__test/login-until/${NOW - 1}`);

                await client.get('/');
                const second = await client.get('/');

                expect(second.text).not.toContain('role="status"');
            });
        });
    });

    describe('GET /: ログインしている時(メモの一覧)', () => {
        beforeEach(async () => {
            await client.get('/__test/login');
        });

        it('RS を、アクセストークンつきで、1 回呼ぶ', async () => {
            const response = await client.get('/');

            expect(response.status).toBe(200);
            expect(memoApi.list).toHaveBeenCalledOnce();
            expect(memoApi.list).toHaveBeenCalledWith(TEST_TOKENS.accessToken);
        });

        it('メモの本文と、詳細画面へのリンクが出る', async () => {
            const response = await client.get('/');

            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            for (const m of MEMOS) {
                expect(response.text).toContain(m.body);
                expect(response.text).toContain(`href="/detail/${m.id}"`);
            }
            expect(response.text).toContain('id="memos"');
        });

        it('更新が新しい順に並ぶ(RS は、古い順で返してくる)', async () => {
            const response = await client.get('/');

            const [m1, m2, m3] = positionsOf(response.text, [
                '牛乳を買う',
                'Buy Milk and eggs',
                'レポートを書く',
            ]);

            expect(m3).toBeGreaterThan(-1);
            expect(m3).toBeLessThan(m2 ?? -1);
            expect(m2).toBeLessThan(m1 ?? -1);
        });

        it('アクセストークンは、画面に出さない', async () => {
            const response = await client.get('/');

            expect(response.text).not.toContain(TEST_TOKENS.accessToken);
        });

        it('メモの本文の中の HTML は、エスケープして出す', async () => {
            memoApi.list.mockResolvedValue({
                ok: true,
                data: [
                    memo(
                        'x1',
                        '<script>alert(1)</script>',
                        '2026-11-01T00:00:00.000Z',
                    ),
                ],
            });

            const response = await client.get('/');

            expect(response.text).toContain('&lt;script&gt;alert(1)');
            expect(response.text).not.toMatch(/<script/i);
        });

        it('メモが 0 件なら、メモが無い、という画面', async () => {
            memoApi.list.mockResolvedValue({ ok: true, data: [] });

            const response = await client.get('/');

            expect(response.status).toBe(200);
            expect(response.text).toContain('id="empty"');
            expect(response.text).not.toContain('id="memos"');
        });

        it('フォームの CSRF トークンは、セッションの物と同じ。開き直しても、同じ', async () => {
            const first = await client.get('/');
            const second = await client.get('/');
            const session = await readSession(client);
            const tokensIn = (html: string) =>
                [...html.matchAll(/name="_csrf" value="([^"]*)"/g)].map(
                    (match) => match[1],
                );

            expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(tokensIn(first.text).length).toBeGreaterThanOrEqual(2);
            for (const token of tokensIn(first.text))
                expect(token).toBe(session.csrfToken);
            expect(tokensIn(second.text)).toEqual(tokensIn(first.text));
        });

        it('キャッシュさせない', async () => {
            const response = await client.get('/');

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('セッションにメッセージ(flash)があれば、出す。出したら、消える(1 回だけ)', async () => {
            await client.get('/__test/flash?text=メモを追加しました');

            const first = await client.get('/');
            const second = await client.get('/');

            expect(first.text).toContain('メモを追加しました');
            expect(first.text).toContain('role="status"');
            expect(second.text).not.toContain('メモを追加しました');
            expect((await readSession(client)).flash).toBeNull();
        });

        it('メッセージが無ければ、メッセージの欄は出ない', async () => {
            const response = await client.get('/');

            expect(response.text).not.toContain('role="status"');
        });

        it('GET / では、セッションは捨てない(ログインは、そのまま)', async () => {
            const cookie = client.cookies.get(SESSION_COOKIE_NAME);

            await client.get('/');

            expect(client.cookies.get(SESSION_COOKIE_NAME)).toBe(cookie);
            expect((await readSession(client)).tokens).not.toBeNull();
        });
    });

    describe('GET /?q=(検索)', () => {
        beforeEach(async () => {
            await client.get('/__test/login');
        });

        it('検索語を含むメモだけが、出る', async () => {
            const response = await client.get('/?q=milk');

            expect(response.text).toContain('Buy Milk and eggs');
            expect(response.text).not.toContain('牛乳を買う');
            expect(response.text).not.toContain('レポートを書く');
        });

        it('見つかった件数と、検索語が入った検索欄が出る', async () => {
            const response = await client.get('/?q=milk');

            expect(response.text).toMatch(/id="result-count"[^>]*>\s*1 件/);
            expect(response.text).toMatch(
                /<input\b[^>]*\bname="q"[^>]*\bvalue="milk"/,
            );
        });

        it('全角と半角、大文字と小文字は、区別しない', async () => {
            const response = await client.get(
                `/?q=${encodeURIComponent('ＭＩＬＫ')}`,
            );

            expect(response.text).toContain('Buy Milk and eggs');
        });

        it('空白で区切った語は、全部を含むメモだけが、出る(AND)', async () => {
            const both = await client.get('/?q=milk+eggs');
            const none = await client.get('/?q=milk+レポート');

            expect(both.text).toContain('Buy Milk and eggs');
            expect(none.text).toContain('id="no-match"');
        });

        it('該当が無ければ、該当なしの画面(検索語つき)', async () => {
            const response = await client.get('/?q=みかん');

            expect(response.status).toBe(200);
            expect(response.text).toContain('id="no-match"');
            expect(response.text).toContain('みかん');
            expect(response.text).not.toContain('id="memos"');
            expect(response.text).toMatch(/id="result-count"[^>]*>\s*0 件/);
        });

        it('検索した結果も、更新が新しい順', async () => {
            const response = await client.get(
                '/?q=' + encodeURIComponent('を'),
            );

            const [m1, m3] = positionsOf(response.text, [
                '牛乳を買う',
                'レポートを書く',
            ]);

            expect(m3).toBeGreaterThan(-1);
            expect(m3).toBeLessThan(m1 ?? -1);
        });

        it.each([
            { name: '空', query: '' },
            { name: '半角の空白だけ', query: '%20%20' },
            {
                name: '全角の空白だけ',
                query: encodeURIComponent(IDEOGRAPHIC_SPACE),
            },
        ])(
            '検索語が $name なら、検索しない(全部出る。件数も出ない)',
            async ({ query }) => {
                const response = await client.get(`/?q=${query}`);

                for (const m of MEMOS) expect(response.text).toContain(m.body);
                expect(response.text).not.toContain('result-count');
            },
        );

        it('検索語の前後の空白は、取って、検索欄に戻す', async () => {
            const response = await client.get('/?q=++milk++');

            expect(response.text).toMatch(
                /<input\b[^>]*\bname="q"[^>]*\bvalue="milk"/,
            );
            expect(response.text).toContain('Buy Milk and eggs');
        });

        it('検索語の中の HTML は、エスケープして出す', async () => {
            const query = '"><script>alert(1)</script>';

            const response = await client.get(
                `/?q=${encodeURIComponent(query)}`,
            );

            expect(response.text).not.toMatch(/<script/i);
            expect(response.text).toContain('&#34;&gt;&lt;script&gt;');
        });

        it('RS には、検索語を送らない(トークンだけ)', async () => {
            await client.get('/?q=milk');

            expect(memoApi.list).toHaveBeenCalledWith(TEST_TOKENS.accessToken);
        });

        it('検索語が 200 文字ちょうどなら、良い。201 文字なら、400(RS も呼ばない)', async () => {
            const ok = await client.get(`/?q=${'a'.repeat(200)}`);
            expect(ok.status).toBe(200);
            expect(memoApi.list).toHaveBeenCalledOnce();

            const tooLong = await client.get(`/?q=${'a'.repeat(201)}`);
            expectErrorPage(tooLong, 400);
            expect(memoApi.list).toHaveBeenCalledOnce();
        });

        it('検索語が 2 つあれば、400(RS も呼ばない)', async () => {
            const response = await client.get('/?q=a&q=b');

            expectErrorPage(response, 400);
            expect(memoApi.list).not.toHaveBeenCalled();
        });
    });

    describe('GET /: RS が失敗した時', () => {
        beforeEach(async () => {
            await client.get('/__test/login');
        });

        it('401(unauthorized)なら、セッションを捨てて、/ へ 303。メッセージが入る', async () => {
            memoApi.list.mockResolvedValue({
                ok: false,
                failure: 'unauthorized',
            });
            const before = client.cookies.get(SESSION_COOKIE_NAME);

            const response = await client.get('/');
            const session = await readSession(client);

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
            expect(session.tokens).toBeNull();
            expect(typeof session.flash).toBe('string');
            expect(session.flash).not.toBe('');
            expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(before);
        });

        it('401 のあとに / を開くと、ログインを促す画面と、メッセージが出る', async () => {
            memoApi.list.mockResolvedValueOnce({
                ok: false,
                failure: 'unauthorized',
            });
            await client.get('/');

            const response = await client.get('/');

            expect(response.status).toBe(200);
            expect(response.text).toContain('href="/login"');
            expect(response.text).toContain('role="status"');
        });

        it.each(PAGE_FAILURES)(
            '$failure なら、$status のエラー画面。ログインは、そのまま',
            async ({ failure, status }) => {
                memoApi.list.mockResolvedValue({ ok: false, failure });

                const response = await client.get('/');

                expectErrorPage(response, status);
                expect((await readSession(client)).tokens).not.toBeNull();
            },
        );

        it('RS の呼び出しが、例外を投げたら、500 のエラー画面。中身は、画面に出さない', async () => {
            memoApi.list.mockRejectedValue(new Error('SECRET-INTERNAL-DETAIL'));

            const response = await client.get('/');

            expectErrorPage(response, 500);
            expect(response.text).not.toContain('SECRET-INTERNAL-DETAIL');
        });
    });

    describe('POST /: メモを作る', () => {
        describe('作れる', () => {
            it('RS に、アクセストークンと本文を渡して、1 回だけ作る', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: '牛乳を買う' });

                expect(memoApi.create).toHaveBeenCalledOnce();
                expect(memoApi.create).toHaveBeenCalledWith(
                    TEST_TOKENS.accessToken,
                    '牛乳を買う',
                );
                expect(memoApi.list).not.toHaveBeenCalled();
            });

            it('/ へ 303(画面を開き直しても、二重に作らない)', async () => {
                const token = await loginAndOpenForm();

                const response = await create(token, { body: 'メモ' });

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
            });

            it('メッセージ(flash)が入る。次に / を開くと、1 回だけ出る', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: 'メモ' });
                const { flash } = await readSession(client);
                const first = await client.get('/');
                const second = await client.get('/');

                expect(typeof flash).toBe('string');
                expect(flash).not.toBe('');
                expect(first.text).toContain(flash ?? 'x');
                expect(second.text).not.toContain('role="status"');
            });

            it('ログインは、そのまま(セッションを捨てない)', async () => {
                const token = await loginAndOpenForm();
                const cookie = client.cookies.get(SESSION_COOKIE_NAME);

                await create(token, { body: 'メモ' });

                expect(client.cookies.get(SESSION_COOKIE_NAME)).toBe(cookie);
                expect((await readSession(client)).tokens).not.toBeNull();
            });

            it('改行は、LF にそろえて、渡す(ブラウザは、CRLF で送ってくる)', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: 'a\r\nb\rc\nd' });

                expect(memoApi.create.mock.calls[0]?.[1]).toBe('a\nb\nc\nd');
            });

            it('前後の空白や改行は、そのまま渡す', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: '  hello  \n' });

                expect(memoApi.create.mock.calls[0]?.[1]).toBe('  hello  \n');
            });

            it('本文の中の HTML も、そのまま渡す(エスケープは、画面の仕事)', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: '<b>&</b>' });

                expect(memoApi.create.mock.calls[0]?.[1]).toBe('<b>&</b>');
            });

            it('フォームの余計な項目は、無視する(RS に渡すのは、本文だけ)', async () => {
                const token = await loginAndOpenForm();

                await create(token, {
                    body: 'メモ',
                    id: 'forced-id',
                    owner: 'someone-else',
                });

                expect(memoApi.create).toHaveBeenCalledWith(
                    TEST_TOKENS.accessToken,
                    'メモ',
                );
            });

            it('キャッシュさせない', async () => {
                const token = await loginAndOpenForm();

                const response = await create(token, { body: 'メモ' });

                expect(response.headers.get('cache-control')).toBe('no-store');
            });
        });

        describe('本文が使えない時(やり直しの画面へ戻して、メッセージを出す)', () => {
            it.each([
                { name: '本文の項目が無い', body: {} },
                { name: '本文が空', body: { body: '' } },
                { name: '半角の空白だけ', body: { body: '   ' } },
                {
                    name: '全角の空白と改行だけ',
                    body: {
                        body: `${IDEOGRAPHIC_SPACE}\r\n${IDEOGRAPHIC_SPACE}`,
                    },
                },
            ])(
                '$name なら、/ へ 303。メッセージが入る。作らない',
                async ({ body }) => {
                    const token = await loginAndOpenForm();

                    const response = await create(token, body);
                    const { flash } = await readSession(client);

                    expect(response.status).toBe(303);
                    expect(response.location).toBe('/');
                    expect(typeof flash).toBe('string');
                    expect(flash).not.toBe('');
                    expect(memoApi.create).not.toHaveBeenCalled();
                },
            );

            it('10000 文字ちょうどは、作る。10001 文字なら、メッセージを出して、作らない', async () => {
                const token = await loginAndOpenForm();

                const ok = await create(token, { body: 'a'.repeat(10_000) });
                expect(ok.location).toBe('/');
                expect(memoApi.create).toHaveBeenCalledOnce();
                const created = (await readSession(client)).flash;

                const tooLong = await create(token, {
                    body: 'a'.repeat(10_001),
                });
                const refused = (await readSession(client)).flash;

                expect(tooLong.status).toBe(303);
                expect(tooLong.location).toBe('/');
                expect(memoApi.create).toHaveBeenCalledOnce();
                expect(refused).not.toBeNull();
                // 作れた時とは、違うメッセージ
                expect(refused).not.toBe(created);
            });

            it('空の時と、長すぎる時で、メッセージが違う', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: '' });
                const empty = (await readSession(client)).flash;
                await create(token, { body: 'a'.repeat(10_001) });
                const tooLong = (await readSession(client)).flash;

                expect(empty).not.toBeNull();
                expect(tooLong).not.toBeNull();
                expect(empty).not.toBe(tooLong);
            });

            it('絵文字は、1 文字として数える(10000 個ちょうどは、作れる)', async () => {
                const token = await loginAndOpenForm();

                await create(token, { body: '😀'.repeat(10_000) });

                expect(memoApi.create).toHaveBeenCalledOnce();
            });

            it('本文が、URL のクエリにあるだけなら、本文が無い物として扱う(作らない)', async () => {
                const token = await loginAndOpenForm();

                const response = await client.postForm('/?body=from-query', {
                    _csrf: token,
                });

                expect(response.status).toBe(303);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('本文が 2 つあれば、400。作らない', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(`_csrf=${token}&body=a&body=b`);

                expect(response.status).toBe(400);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('本文が大きすぎるリクエスト(200KB)は、413。作らない', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    `_csrf=${token}&body=${'a'.repeat(200_000)}`,
                );

                expect(response.status).toBe(413);
                expect(memoApi.create).not.toHaveBeenCalled();
            });
        });

        describe('CSRF(他のサイトから、勝手にメモを作られない)', () => {
            it('トークンが無ければ、403。作らない', async () => {
                await loginAndOpenForm();

                const response = await client.postForm('/', { body: 'メモ' });

                expectErrorPage(response, 403);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it.each([
                { name: '違うトークン', token: 'x'.repeat(43) },
                { name: '空のトークン', token: '' },
            ])(
                '$name なら、403。作らない。ログインは、そのまま',
                async ({ token }) => {
                    await loginAndOpenForm();

                    const response = await create(token, { body: 'メモ' });

                    expectErrorPage(response, 403);
                    expect(memoApi.create).not.toHaveBeenCalled();
                    expect((await readSession(client)).tokens).not.toBeNull();
                },
            );

            it('トークンが 2 つあれば、403', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    `_csrf=${token}&_csrf=${token}&body=メモ`,
                );

                expect(response.status).toBe(403);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('トークンが、URL のクエリにあるだけでは、403(トークンは、本文で受け取る)', async () => {
                const token = await loginAndOpenForm();

                const response = await client.postForm(`/?_csrf=${token}`, {
                    body: 'メモ',
                });

                expectErrorPage(response, 403);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('セッションを持っていない人が、トークンだけ付けても、403', async () => {
                const token = await loginAndOpenForm();
                const stranger = createClient(server.baseUrl);

                const response = await create(
                    token,
                    { body: 'メモ' },
                    stranger,
                );

                expectErrorPage(response, 403);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('別の人(別のセッション)のトークンでは、403', async () => {
                await loginAndOpenForm();
                const other = createClient(server.baseUrl);
                const othersToken = await loginAndOpenForm(other);

                const response = await create(othersToken, { body: 'メモ' });

                expectErrorPage(response, 403);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('フォームの形じゃない本文(JSON)でも、500 にならず 403', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    JSON.stringify({ _csrf: token, body: 'メモ' }),
                    'application/json',
                );

                expect(response.status).toBe(403);
                expect(memoApi.create).not.toHaveBeenCalled();
            });

            it('CSRF の確認は、本文の確認より先(トークンが違えば、本文が空でも 403)', async () => {
                await loginAndOpenForm();

                const response = await create('x'.repeat(43), { body: '' });

                expectErrorPage(response, 403);
            });

            it('403 の画面に、送られたトークンも、本文も、出さない。キャッシュもさせない', async () => {
                await loginAndOpenForm();

                const response = await create('<b>forged-token</b>', {
                    body: '<i>forged-body</i>',
                });

                expect(response.text).not.toContain('forged-token');
                expect(response.text).not.toContain('forged-body');
                expect(response.headers.get('cache-control')).toBe('no-store');
            });
        });

        describe('ログインが切れている時', () => {
            it('トークンが無い(ログインしていない)なら、セッションを捨てて、/ へ 303。作らない', async () => {
                const token = (await client.get('/__test/csrf')).text;

                const response = await create(token, { body: 'メモ' });
                const session = await readSession(client);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                expect(memoApi.create).not.toHaveBeenCalled();
                expect(session.csrfToken).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(session.flash).not.toBe('');
            });

            it.each([
                { name: '期限切れ', expiresAt: NOW - 1 },
                { name: '期限の 30 秒前(余裕の中)', expiresAt: NOW + 30 },
            ])(
                'トークンが $name なら、セッションを捨てて、/ へ 303。作らない',
                async ({ expiresAt }) => {
                    await client.get(`/__test/login-until/${expiresAt}`);
                    const token = (await client.get('/__test/csrf')).text;
                    const before = client.cookies.get(SESSION_COOKIE_NAME);

                    const response = await create(token, { body: 'メモ' });
                    const session = await readSession(client);

                    expect(response.status).toBe(303);
                    expect(response.location).toBe('/');
                    expect(memoApi.create).not.toHaveBeenCalled();
                    expect(session.tokens).toBeNull();
                    expect(typeof session.flash).toBe('string');
                    expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(
                        before,
                    );
                },
            );

            it('ログインが切れていて、本文が空でも、先にログインの確認(メッセージは、ログインの切れた物)', async () => {
                const token = (await client.get('/__test/csrf')).text;

                const response = await create(token, { body: '' });
                const session = await readSession(client);

                expect(response.status).toBe(303);
                // 本文が空のメッセージで、上書きされていない(セッションが捨てられて、新しい)
                expect(session.csrfToken).toBeNull();
            });
        });

        describe('RS が失敗した時', () => {
            it('401(unauthorized)なら、セッションを捨てて、/ へ 303。メッセージが入る', async () => {
                const token = await loginAndOpenForm();
                memoApi.create.mockResolvedValue({
                    ok: false,
                    failure: 'unauthorized',
                });

                const response = await create(token, { body: 'メモ' });
                const session = await readSession(client);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                expect(session.tokens).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(memoApi.create).toHaveBeenCalledOnce();
            });

            it.each(PAGE_FAILURES)(
                '$failure なら、$status のエラー画面。ログインは、そのまま',
                async ({ failure, status }) => {
                    const token = await loginAndOpenForm();
                    memoApi.create.mockResolvedValue({ ok: false, failure });

                    const response = await create(token, { body: 'メモ' });

                    expectErrorPage(response, status);
                    expect((await readSession(client)).tokens).not.toBeNull();
                },
            );

            it('失敗した時は、「追加しました」のメッセージを、入れない', async () => {
                const token = await loginAndOpenForm();
                memoApi.create.mockResolvedValue({
                    ok: false,
                    failure: 'unavailable',
                });

                await create(token, { body: 'メモ' });

                expect((await readSession(client)).flash).toBeNull();
            });

            it('RS の呼び出しが、例外を投げたら、500 のエラー画面。中身は、画面に出さない', async () => {
                const token = await loginAndOpenForm();
                memoApi.create.mockRejectedValue(
                    new Error('SECRET-INTERNAL-DETAIL'),
                );

                const response = await create(token, { body: 'メモ' });

                expectErrorPage(response, 500);
                expect(response.text).not.toContain('SECRET-INTERNAL-DETAIL');
            });
        });
    });

    describe('GET と POST 以外', () => {
        it('PUT と DELETE は 405。Allow は GET, POST。RS は、呼ばない', async () => {
            await client.get('/__test/login');
            const cookie = [...client.cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join('; ');

            for (const method of ['PUT', 'DELETE', 'PATCH']) {
                const response = await fetch(`${server.baseUrl}/`, {
                    method,
                    redirect: 'manual',
                    headers: { Cookie: cookie },
                });

                expect(response.status).toBe(405);
                expect(response.headers.get('allow')).toBe('GET, POST');
            }
            expect(memoApi.list).not.toHaveBeenCalled();
            expect(memoApi.create).not.toHaveBeenCalled();
        });
    });
});
