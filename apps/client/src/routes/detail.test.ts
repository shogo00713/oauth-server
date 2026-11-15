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
import { createDetailRouter } from './detail.js';

const NOW = 1_800_000_000;

// 見た目では、区別しにくい空白。コードの中に直接書かずに、番号で作る
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);

const memo = (id: string, body = '牛乳を買う'): Memo => ({
    id,
    body,
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-02T10:30:00.000Z',
});

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
        list: vi.fn<MemoApi['list']>(),
        create: vi.fn<MemoApi['create']>(),
        // 渡された id のメモを返す
        get: vi.fn<MemoApi['get']>(async (_token, id) => ({
            ok: true,
            data: memo(id),
        })),
        update: vi.fn<MemoApi['update']>(async (_token, id, body) => ({
            ok: true,
            data: memo(id, body),
        })),
        delete: vi.fn<MemoApi['delete']>(async () => ({
            ok: true,
            data: undefined,
        })),
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
            app.use('/detail', createDetailRouter({ memoApi, now: () => NOW }));
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

// /detail/<id>(id は、URL として安全な形にする)
const pathOf = (id: string) => `/detail/${encodeURIComponent(id)}`;

const send = (
    token: string,
    fields: Record<string, string> = {},
    id = 'm1',
    who: TestClient = client,
) => who.postForm(pathOf(id), { _csrf: token, ...fields });

const update = (
    token: string,
    body: string,
    id = 'm1',
    who: TestClient = client,
) => send(token, { action: 'update', body }, id, who);

const remove = (token: string, id = 'm1', who: TestClient = client) =>
    send(token, { action: 'delete' }, id, who);

// フォームの形で、そのまま送る(項目が 2 回ある、などを試すため)
const rawPost = (
    path: string,
    body: string,
    contentType = 'application/x-www-form-urlencoded',
    who: TestClient = client,
) => {
    const cookie = [...who.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
    return fetch(`${server.baseUrl}${path}`, {
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

// RS を、何も呼んでいないこと
const expectNoRsCall = () => {
    expect(memoApi.get).not.toHaveBeenCalled();
    expect(memoApi.update).not.toHaveBeenCalled();
    expect(memoApi.delete).not.toHaveBeenCalled();
};

describe('DETAIL /detail/:id メモの表示、保存、削除', () => {
    describe('GET /detail/:id: ログインしていない時', () => {
        it('/ へ 303。RS は、呼ばない。Cookie も出さない', async () => {
            const response = await client.get('/detail/m1');

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
            expectNoRsCall();
            expect(response.headers.getSetCookie()).toEqual([]);
        });

        it('キャッシュさせない', async () => {
            const response = await client.get('/detail/m1');

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('セッションのメッセージ(flash)には、触らない(/ で、出せるように)', async () => {
            await client.get('/__test/flash?text=ログアウトしました');

            await client.get('/detail/m1');

            expect((await readSession(client)).flash).toBe(
                'ログアウトしました',
            );
        });

        describe('期限切れのトークンが残っている時', () => {
            it.each([
                { name: '期限切れ', expiresAt: NOW - 1 },
                { name: '期限ちょうど', expiresAt: NOW },
                { name: '期限の 30 秒前(余裕の中)', expiresAt: NOW + 30 },
            ])(
                '$name: セッションを捨てて、/ へ 303。メッセージが入る。RS は、呼ばない',
                async ({ expiresAt }) => {
                    await client.get(`/__test/login-until/${expiresAt}`);
                    const before = client.cookies.get(SESSION_COOKIE_NAME);

                    const response = await client.get('/detail/m1');
                    const session = await readSession(client);

                    expect(response.status).toBe(303);
                    expect(response.location).toBe('/');
                    expect(session.tokens).toBeNull();
                    expect(typeof session.flash).toBe('string');
                    expect(session.flash).not.toBe('');
                    expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(
                        before,
                    );
                    expectNoRsCall();
                },
            );
        });
    });

    describe('GET /detail/:id: ログインしている時', () => {
        beforeEach(async () => {
            await client.get('/__test/login');
        });

        it('RS を、アクセストークンと id つきで、1 回呼ぶ', async () => {
            const response = await client.get('/detail/m1');

            expect(response.status).toBe(200);
            expect(memoApi.get).toHaveBeenCalledOnce();
            expect(memoApi.get).toHaveBeenCalledWith(
                TEST_TOKENS.accessToken,
                'm1',
            );
        });

        it('メモの本文と、作成日時、更新日時が出る', async () => {
            memoApi.get.mockResolvedValue({
                ok: true,
                data: memo('m1', 'レポートを書く'),
            });

            const response = await client.get('/detail/m1');

            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.text).toContain('レポートを書く');
            expect(response.text).toContain('2026-11-01T09:00:00.000Z');
            expect(response.text).toContain('2026-11-02T10:30:00.000Z');
        });

        it('保存と削除のフォームは、/detail/<id> に POST する', async () => {
            const response = await client.get('/detail/m1');

            expect(response.text).toContain('value="update"');
            expect(response.text).toContain('value="delete"');
            expect([
                ...response.text.matchAll(/<form\b[^>]*action="\/detail\/m1"/g),
            ]).toHaveLength(2);
        });

        it('フォームの CSRF トークンは、セッションの物と同じ。開き直しても、同じ', async () => {
            const first = await client.get('/detail/m1');
            const second = await client.get('/detail/m1');
            const session = await readSession(client);
            const tokensIn = (html: string) =>
                [...html.matchAll(/name="_csrf" value="([^"]*)"/g)].map(
                    (match) => match[1],
                );

            expect(session.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(tokensIn(first.text).length).toBeGreaterThanOrEqual(3);
            for (const token of tokensIn(first.text))
                expect(token).toBe(session.csrfToken);
            expect(tokensIn(second.text)).toEqual(tokensIn(first.text));
        });

        it('アクセストークンは、画面に出さない', async () => {
            const response = await client.get('/detail/m1');

            expect(response.text).not.toContain(TEST_TOKENS.accessToken);
        });

        it('メモの本文の中の HTML は、エスケープして出す(textarea を閉じるタグでも)', async () => {
            memoApi.get.mockResolvedValue({
                ok: true,
                data: memo('m1', '</textarea><script>alert(1)</script>'),
            });

            const response = await client.get('/detail/m1');

            expect(response.text).not.toMatch(/<script/i);
            expect(response.text).toContain('&lt;/textarea&gt;&lt;script&gt;');
        });

        it('キャッシュさせない', async () => {
            const response = await client.get('/detail/m1');

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('セッションにメッセージ(flash)があれば、出す。出したら、消える(1 回だけ)', async () => {
            await client.get('/__test/flash?text=メモを保存しました');

            const first = await client.get('/detail/m1');
            const second = await client.get('/detail/m1');

            expect(first.text).toContain('メモを保存しました');
            expect(first.text).toContain('role="status"');
            expect(second.text).not.toContain('メモを保存しました');
            expect((await readSession(client)).flash).toBeNull();
        });

        it('メッセージが無ければ、メッセージの欄は出ない', async () => {
            const response = await client.get('/detail/m1');

            expect(response.text).not.toContain('role="status"');
        });

        it('GET では、セッションは捨てない(ログインは、そのまま)', async () => {
            const cookie = client.cookies.get(SESSION_COOKIE_NAME);

            await client.get('/detail/m1');

            expect(client.cookies.get(SESSION_COOKIE_NAME)).toBe(cookie);
            expect((await readSession(client)).tokens).not.toBeNull();
        });

        describe('URL の id', () => {
            it('そのまま RS に渡す(英数字と - _)', async () => {
                await client.get('/detail/abc-DEF_123');

                expect(memoApi.get.mock.calls[0]?.[1]).toBe('abc-DEF_123');
            });

            it('%XX は、戻してから、渡す', async () => {
                await client.get(`/detail/${encodeURIComponent('a/b')}`);

                expect(memoApi.get.mock.calls[0]?.[1]).toBe('a/b');
            });

            it('画面の中の id は、HTML の文字としても、URL としても、安全な形で出る', async () => {
                const id = '<script>"x"?y#z';

                const response = await client.get(pathOf(id));

                expect(response.status).toBe(200);
                expect(response.text).not.toMatch(/<script/i);
                expect(response.text).toContain(
                    `action="/detail/${encodeURIComponent(id)}"`,
                );
            });

            it('壊れた %XX(%E0%A4%A)は、400 のエラー画面。RS は、呼ばない', async () => {
                const response = await client.get('/detail/%E0%A4%A');

                expectErrorPage(response, 400);
                expectNoRsCall();
            });

            it.each(['/detail', '/detail/', '/detail/a/b'])(
                'id が無い、または、/ が入っている道(%s)は、404。RS は、呼ばない',
                async (path) => {
                    const response = await client.get(path);

                    expectErrorPage(response, 404);
                    expectNoRsCall();
                },
            );
        });
    });

    describe('GET /detail/:id: RS が失敗した時', () => {
        beforeEach(async () => {
            await client.get('/__test/login');
        });

        it('401(unauthorized)なら、セッションを捨てて、/ へ 303。メッセージが入る', async () => {
            memoApi.get.mockResolvedValue({
                ok: false,
                failure: 'unauthorized',
            });
            const before = client.cookies.get(SESSION_COOKIE_NAME);

            const response = await client.get('/detail/m1');
            const session = await readSession(client);

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
            expect(session.tokens).toBeNull();
            expect(typeof session.flash).toBe('string');
            expect(session.flash).not.toBe('');
            expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(before);
        });

        it.each(PAGE_FAILURES)(
            '$failure なら、$status のエラー画面。ログインは、そのまま',
            async ({ failure, status }) => {
                memoApi.get.mockResolvedValue({ ok: false, failure });

                const response = await client.get('/detail/m1');

                expectErrorPage(response, status);
                expect((await readSession(client)).tokens).not.toBeNull();
            },
        );

        it('RS の呼び出しが、例外を投げたら、500 のエラー画面。中身は、画面に出さない', async () => {
            memoApi.get.mockRejectedValue(new Error('SECRET-INTERNAL-DETAIL'));

            const response = await client.get('/detail/m1');

            expectErrorPage(response, 500);
            expect(response.text).not.toContain('SECRET-INTERNAL-DETAIL');
        });
    });

    describe('POST /detail/:id: 保存(action=update)', () => {
        describe('保存できる', () => {
            it('RS に、アクセストークンと id と本文を渡して、1 回だけ更新する', async () => {
                const token = await loginAndOpenForm();

                await update(token, '牛乳と卵を買う');

                expect(memoApi.update).toHaveBeenCalledOnce();
                expect(memoApi.update).toHaveBeenCalledWith(
                    TEST_TOKENS.accessToken,
                    'm1',
                    '牛乳と卵を買う',
                );
                expect(memoApi.delete).not.toHaveBeenCalled();
            });

            it('/detail/<id> へ 303(画面を開き直しても、二重に送らない)', async () => {
                const token = await loginAndOpenForm();

                const response = await update(token, 'メモ');

                expect(response.status).toBe(303);
                expect(response.location).toBe('/detail/m1');
            });

            it('メッセージ(flash)が入る。次に画面を開くと、1 回だけ出る', async () => {
                const token = await loginAndOpenForm();

                await update(token, 'メモ');
                const { flash } = await readSession(client);
                const first = await client.get('/detail/m1');
                const second = await client.get('/detail/m1');

                expect(typeof flash).toBe('string');
                expect(flash).not.toBe('');
                expect(first.text).toContain(flash ?? 'x');
                expect(second.text).not.toContain('role="status"');
            });

            it('ログインは、そのまま(セッションを捨てない)', async () => {
                const token = await loginAndOpenForm();
                const cookie = client.cookies.get(SESSION_COOKIE_NAME);

                await update(token, 'メモ');

                expect(client.cookies.get(SESSION_COOKIE_NAME)).toBe(cookie);
                expect((await readSession(client)).tokens).not.toBeNull();
            });

            it('戻す道の id は、URL として安全な形にする(別の道へ飛ばせない)', async () => {
                const token = await loginAndOpenForm();
                const id = 'a/../b?x=1#y"z';

                const response = await update(token, 'メモ', id);

                expect(response.status).toBe(303);
                expect(response.location).toBe(
                    `/detail/${encodeURIComponent(id)}`,
                );
                expect(memoApi.update.mock.calls[0]?.[1]).toBe(id);
            });

            it.each(['//evil.example/', 'https://evil.example/', '../..'])(
                'id が %s でも、戻す先は、/detail/ の下の道だけ',
                async (id) => {
                    const token = await loginAndOpenForm();

                    const response = await update(token, 'メモ', id);

                    expect(response.location).toBe(
                        `/detail/${encodeURIComponent(id)}`,
                    );
                    expect(response.location).toMatch(/^\/detail\/[^/]+$/);
                },
            );

            it('改行は、LF にそろえて、渡す(ブラウザは、CRLF で送ってくる)', async () => {
                const token = await loginAndOpenForm();

                await update(token, 'a\r\nb\rc\nd');

                expect(memoApi.update.mock.calls[0]?.[2]).toBe('a\nb\nc\nd');
            });

            it('前後の空白や改行は、そのまま渡す', async () => {
                const token = await loginAndOpenForm();

                await update(token, '  hello  \n');

                expect(memoApi.update.mock.calls[0]?.[2]).toBe('  hello  \n');
            });

            it('本文の中の HTML も、そのまま渡す(エスケープは、画面の仕事)', async () => {
                const token = await loginAndOpenForm();

                await update(token, '<b>&</b>');

                expect(memoApi.update.mock.calls[0]?.[2]).toBe('<b>&</b>');
            });

            it('フォームの余計な項目は、無視する(RS に渡すのは、本文だけ)', async () => {
                const token = await loginAndOpenForm();

                await send(token, {
                    action: 'update',
                    body: 'メモ',
                    owner: 'someone-else',
                    id: 'another-id',
                });

                expect(memoApi.update).toHaveBeenCalledWith(
                    TEST_TOKENS.accessToken,
                    'm1',
                    'メモ',
                );
            });

            it('キャッシュさせない', async () => {
                const token = await loginAndOpenForm();

                const response = await update(token, 'メモ');

                expect(response.headers.get('cache-control')).toBe('no-store');
            });

            it('絵文字は、1 文字として数える(10000 個ちょうどは、保存できる)', async () => {
                const token = await loginAndOpenForm();

                const response = await update(token, '😀'.repeat(10_000));

                expect(response.location).toBe('/detail/m1');
                expect(memoApi.update).toHaveBeenCalledOnce();
            });
        });

        describe('本文が使えない時(メモの画面へ戻して、メッセージを出す)', () => {
            it.each([
                { name: '本文の項目が無い', fields: { action: 'update' } },
                {
                    name: '本文が空',
                    fields: { action: 'update', body: '' },
                },
                {
                    name: '半角の空白だけ',
                    fields: { action: 'update', body: '   ' },
                },
                {
                    name: '全角の空白と改行だけ',
                    fields: {
                        action: 'update',
                        body: `${IDEOGRAPHIC_SPACE}\r\n${IDEOGRAPHIC_SPACE}`,
                    },
                },
            ])(
                '$name なら、/detail/<id> へ 303。メッセージが入る。更新しない',
                async ({ fields }) => {
                    const token = await loginAndOpenForm();

                    const response = await send(token, fields);
                    const { flash } = await readSession(client);

                    expect(response.status).toBe(303);
                    expect(response.location).toBe('/detail/m1');
                    expect(typeof flash).toBe('string');
                    expect(flash).not.toBe('');
                    expect(memoApi.update).not.toHaveBeenCalled();
                },
            );

            it('10000 文字ちょうどは、保存する。10001 文字なら、メッセージを出して、保存しない', async () => {
                const token = await loginAndOpenForm();

                await update(token, 'a'.repeat(10_000));
                expect(memoApi.update).toHaveBeenCalledOnce();
                const saved = (await readSession(client)).flash;

                const tooLong = await update(token, 'a'.repeat(10_001));
                const refused = (await readSession(client)).flash;

                expect(tooLong.status).toBe(303);
                expect(tooLong.location).toBe('/detail/m1');
                expect(memoApi.update).toHaveBeenCalledOnce();
                expect(refused).not.toBeNull();
                // 保存できた時とは、違うメッセージ
                expect(refused).not.toBe(saved);
            });

            it('空の時と、長すぎる時で、メッセージが違う', async () => {
                const token = await loginAndOpenForm();

                await update(token, '');
                const empty = (await readSession(client)).flash;
                await update(token, 'a'.repeat(10_001));
                const tooLong = (await readSession(client)).flash;

                expect(empty).not.toBeNull();
                expect(tooLong).not.toBeNull();
                expect(empty).not.toBe(tooLong);
            });

            it('本文が、URL のクエリにあるだけなら、本文が無い物として扱う(更新しない)', async () => {
                const token = await loginAndOpenForm();

                const response = await client.postForm(
                    `${pathOf('m1')}?body=from-query`,
                    { _csrf: token, action: 'update' },
                );

                expect(response.status).toBe(303);
                expect(memoApi.update).not.toHaveBeenCalled();
            });

            it('本文が 2 つあれば、400。更新しない', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    pathOf('m1'),
                    `_csrf=${token}&action=update&body=a&body=b`,
                );

                expect(response.status).toBe(400);
                expect(memoApi.update).not.toHaveBeenCalled();
            });

            it('リクエストが大きすぎる(200KB)なら、413。更新しない', async () => {
                const token = await loginAndOpenForm();

                const response = await rawPost(
                    pathOf('m1'),
                    `_csrf=${token}&action=update&body=${'a'.repeat(200_000)}`,
                );

                expect(response.status).toBe(413);
                expect(memoApi.update).not.toHaveBeenCalled();
            });
        });
    });

    describe('POST /detail/:id: 削除(action=delete)', () => {
        it('RS に、アクセストークンと id を渡して、1 回だけ削除する', async () => {
            const token = await loginAndOpenForm();

            await remove(token);

            expect(memoApi.delete).toHaveBeenCalledOnce();
            expect(memoApi.delete).toHaveBeenCalledWith(
                TEST_TOKENS.accessToken,
                'm1',
            );
            expect(memoApi.update).not.toHaveBeenCalled();
        });

        it('/ へ 303(もう無いメモの画面には、戻れない)', async () => {
            const token = await loginAndOpenForm();

            const response = await remove(token);

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
        });

        it('メッセージ(flash)が入る', async () => {
            const token = await loginAndOpenForm();

            await remove(token);
            const { flash } = await readSession(client);

            expect(typeof flash).toBe('string');
            expect(flash).not.toBe('');
        });

        it('ログインは、そのまま(セッションを捨てない)', async () => {
            const token = await loginAndOpenForm();
            const cookie = client.cookies.get(SESSION_COOKIE_NAME);

            await remove(token);

            expect(client.cookies.get(SESSION_COOKIE_NAME)).toBe(cookie);
            expect((await readSession(client)).tokens).not.toBeNull();
        });

        it('本文が一緒に届いても、無視する', async () => {
            const token = await loginAndOpenForm();

            await send(token, { action: 'delete', body: '' });

            expect(memoApi.delete).toHaveBeenCalledOnce();
            expect(memoApi.update).not.toHaveBeenCalled();
        });

        it('id が、URL として特別な文字でも、%XX を戻した値を、RS に渡す', async () => {
            const token = await loginAndOpenForm();

            await remove(token, 'a/b');

            expect(memoApi.delete.mock.calls[0]?.[1]).toBe('a/b');
        });

        it('キャッシュさせない', async () => {
            const token = await loginAndOpenForm();

            const response = await remove(token);

            expect(response.headers.get('cache-control')).toBe('no-store');
        });

        it('もう一度削除すると、RS が not_found を返して、404 のエラー画面', async () => {
            const token = await loginAndOpenForm();
            memoApi.delete.mockResolvedValueOnce({
                ok: true,
                data: undefined,
            });
            memoApi.delete.mockResolvedValueOnce({
                ok: false,
                failure: 'not_found',
            });

            const first = await remove(token);
            const second = await remove(token);

            expect(first.status).toBe(303);
            expectErrorPage(second, 404);
        });
    });

    describe('POST /detail/:id: action(保存か、削除か)', () => {
        it.each([
            { name: '無い', fields: {} },
            { name: '空', fields: { action: '' } },
            { name: '知らない値(drop)', fields: { action: 'drop' } },
            {
                name: '大文字(DELETE)',
                fields: { action: 'DELETE' },
            },
            {
                name: '前後に空白(" delete")',
                fields: { action: ' delete' },
            },
        ])(
            'action が $name なら、400。保存も削除もしない',
            async ({ fields }) => {
                const token = await loginAndOpenForm();

                const response = await send(token, {
                    body: 'メモ',
                    ...fields,
                });

                expectErrorPage(response, 400);
                expectNoRsCall();
            },
        );

        it('action が 2 つあれば(update と delete)、400。保存も削除もしない', async () => {
            const token = await loginAndOpenForm();

            const response = await rawPost(
                pathOf('m1'),
                `_csrf=${token}&action=update&action=delete&body=a`,
            );

            expect(response.status).toBe(400);
            expectNoRsCall();
        });

        it('action が、URL のクエリにあるだけなら、無い物として扱う(400)', async () => {
            const token = await loginAndOpenForm();

            const response = await client.postForm(
                `${pathOf('m1')}?action=delete`,
                { _csrf: token },
            );

            expectErrorPage(response, 400);
            expectNoRsCall();
        });

        it('400 の画面に、送られた action を出さない', async () => {
            const token = await loginAndOpenForm();

            const response = await send(token, {
                action: '<b>forged-action</b>',
            });

            expect(response.text).not.toContain('forged-action');
        });
    });

    describe('POST /detail/:id: CSRF(他のサイトから、勝手に書き換えられない)', () => {
        it('トークンが無ければ、403。RS は、呼ばない', async () => {
            await loginAndOpenForm();

            const response = await client.postForm(pathOf('m1'), {
                action: 'delete',
            });

            expectErrorPage(response, 403);
            expectNoRsCall();
        });

        it.each([
            { name: '違うトークン', token: 'x'.repeat(43) },
            { name: '空のトークン', token: '' },
        ])(
            '$name なら、403。RS は、呼ばない。ログインは、そのまま',
            async ({ token }) => {
                await loginAndOpenForm();

                const response = await remove(token);

                expectErrorPage(response, 403);
                expectNoRsCall();
                expect((await readSession(client)).tokens).not.toBeNull();
            },
        );

        it('トークンが 2 つあれば、403', async () => {
            const token = await loginAndOpenForm();

            const response = await rawPost(
                pathOf('m1'),
                `_csrf=${token}&_csrf=${token}&action=delete`,
            );

            expect(response.status).toBe(403);
            expectNoRsCall();
        });

        it('トークンが、URL のクエリにあるだけでは、403(トークンは、本文で受け取る)', async () => {
            const token = await loginAndOpenForm();

            const response = await client.postForm(
                `${pathOf('m1')}?_csrf=${token}`,
                { action: 'delete' },
            );

            expectErrorPage(response, 403);
            expectNoRsCall();
        });

        it('セッションを持っていない人が、トークンだけ付けても、403', async () => {
            const token = await loginAndOpenForm();
            const stranger = createClient(server.baseUrl);

            const response = await remove(token, 'm1', stranger);

            expectErrorPage(response, 403);
            expectNoRsCall();
        });

        it('別の人(別のセッション)のトークンでは、403', async () => {
            await loginAndOpenForm();
            const other = createClient(server.baseUrl);
            const othersToken = await loginAndOpenForm(other);

            const response = await remove(othersToken);

            expectErrorPage(response, 403);
            expectNoRsCall();
        });

        it('フォームの形じゃない本文(JSON)でも、500 にならず 403', async () => {
            const token = await loginAndOpenForm();

            const response = await rawPost(
                pathOf('m1'),
                JSON.stringify({ _csrf: token, action: 'delete' }),
                'application/json',
            );

            expect(response.status).toBe(403);
            expectNoRsCall();
        });

        it('CSRF の確認は、action の確認より先(トークンが違えば、action が無くても 403)', async () => {
            await loginAndOpenForm();

            const response = await send('x'.repeat(43), {});

            expectErrorPage(response, 403);
        });

        it('403 の画面に、送られたトークンも、本文も、出さない。キャッシュもさせない', async () => {
            await loginAndOpenForm();

            const response = await send('<b>forged-token</b>', {
                action: 'update',
                body: '<i>forged-body</i>',
            });

            expect(response.text).not.toContain('forged-token');
            expect(response.text).not.toContain('forged-body');
            expect(response.headers.get('cache-control')).toBe('no-store');
        });
    });

    describe('POST /detail/:id: ログインが切れている時', () => {
        it.each([
            { name: '保存', fields: { action: 'update', body: 'メモ' } },
            { name: '削除', fields: { action: 'delete' } },
        ])(
            'トークンが無い(ログインしていない)なら、$name は、セッションを捨てて、/ へ 303。RS は、呼ばない',
            async ({ fields }) => {
                const token = (await client.get('/__test/csrf')).text;

                const response = await send(token, fields);
                const session = await readSession(client);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                expectNoRsCall();
                expect(session.csrfToken).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(session.flash).not.toBe('');
            },
        );

        it.each([
            { name: '期限切れ', expiresAt: NOW - 1 },
            { name: '期限の 30 秒前(余裕の中)', expiresAt: NOW + 30 },
        ])(
            'トークンが $name なら、セッションを捨てて、/ へ 303。RS は、呼ばない',
            async ({ expiresAt }) => {
                await client.get(`/__test/login-until/${expiresAt}`);
                const token = (await client.get('/__test/csrf')).text;
                const before = client.cookies.get(SESSION_COOKIE_NAME);

                const response = await remove(token);
                const session = await readSession(client);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                expectNoRsCall();
                expect(session.tokens).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(
                    before,
                );
            },
        );

        it('ログインが切れていて、action が不正でも、先にログインの確認(400 ではなく、/ へ 303)', async () => {
            const token = (await client.get('/__test/csrf')).text;

            const response = await send(token, { action: 'drop' });

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
        });
    });

    describe('POST /detail/:id: RS が失敗した時', () => {
        it.each([
            {
                name: '保存',
                fields: { action: 'update', body: 'メモ' },
                api: () => memoApi.update,
            },
            {
                name: '削除',
                fields: { action: 'delete' },
                api: () => memoApi.delete,
            },
        ])(
            '$name: 401(unauthorized)なら、セッションを捨てて、/ へ 303。メッセージが入る',
            async ({ fields, api }) => {
                const token = await loginAndOpenForm();
                api().mockResolvedValue({
                    ok: false,
                    failure: 'unauthorized',
                });

                const response = await send(token, fields);
                const session = await readSession(client);

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
                expect(session.tokens).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(api()).toHaveBeenCalledOnce();
            },
        );

        it.each(PAGE_FAILURES)(
            '保存: $failure なら、$status のエラー画面。ログインは、そのまま',
            async ({ failure, status }) => {
                const token = await loginAndOpenForm();
                memoApi.update.mockResolvedValue({ ok: false, failure });

                const response = await update(token, 'メモ');

                expectErrorPage(response, status);
                expect((await readSession(client)).tokens).not.toBeNull();
            },
        );

        it.each(PAGE_FAILURES)(
            '削除: $failure なら、$status のエラー画面。ログインは、そのまま',
            async ({ failure, status }) => {
                const token = await loginAndOpenForm();
                memoApi.delete.mockResolvedValue({ ok: false, failure });

                const response = await remove(token);

                expectErrorPage(response, status);
                expect((await readSession(client)).tokens).not.toBeNull();
            },
        );

        it('失敗した時は、「保存しました」「削除しました」のメッセージを、入れない', async () => {
            const token = await loginAndOpenForm();
            memoApi.update.mockResolvedValue({
                ok: false,
                failure: 'unavailable',
            });
            memoApi.delete.mockResolvedValue({
                ok: false,
                failure: 'unavailable',
            });

            await update(token, 'メモ');
            await remove(token);

            expect((await readSession(client)).flash).toBeNull();
        });

        it.each([
            { name: '保存', fields: { action: 'update', body: 'メモ' } },
            { name: '削除', fields: { action: 'delete' } },
        ])(
            '$name: RS の呼び出しが、例外を投げたら、500 のエラー画面。中身は、画面に出さない',
            async ({ fields }) => {
                const token = await loginAndOpenForm();
                memoApi.update.mockRejectedValue(
                    new Error('SECRET-INTERNAL-DETAIL'),
                );
                memoApi.delete.mockRejectedValue(
                    new Error('SECRET-INTERNAL-DETAIL'),
                );

                const response = await send(token, fields);

                expectErrorPage(response, 500);
                expect(response.text).not.toContain('SECRET-INTERNAL-DETAIL');
            },
        );
    });

    describe('GET と POST 以外、id の無い道', () => {
        it('PUT と DELETE と PATCH は 405。Allow は GET, POST。RS は、呼ばない', async () => {
            await client.get('/__test/login');
            const cookie = [...client.cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join('; ');

            for (const method of ['PUT', 'DELETE', 'PATCH']) {
                const response = await fetch(`${server.baseUrl}/detail/m1`, {
                    method,
                    redirect: 'manual',
                    headers: { Cookie: cookie },
                });

                expect(response.status).toBe(405);
                expect(response.headers.get('allow')).toBe('GET, POST');
            }
            expectNoRsCall();
        });

        it('POST /detail(id が無い)は、404。RS は、呼ばない', async () => {
            const token = await loginAndOpenForm();

            const response = await client.postForm('/detail', {
                _csrf: token,
                action: 'delete',
            });

            expectErrorPage(response, 404);
            expectNoRsCall();
        });
    });
});
