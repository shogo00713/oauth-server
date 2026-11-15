import express from 'express';
import { describe, expect, it } from 'vitest';
import type { Memo } from '../rs/memo-api.js';
import { createClient, startServer } from '../test-utils/http.js';
import { createPageTestApp } from '../test-utils/page-app.js';
import { configureViews } from './views.js';

// ---- 描画の道具 ----

// 画面(ejs)を、データを渡して、HTML の文字列にする
const render = (
    view: string,
    data: Record<string, unknown> = {},
): Promise<string> => {
    const app = express();
    configureViews(app);
    return new Promise((resolve, reject) => {
        app.render(view, data, (error, html) =>
            error ? reject(error) : resolve(html),
        );
    });
};

const TOKEN = 'csrf-token-for-test';

const memo = (overrides: Partial<Memo> = {}): Memo => ({
    id: 'memo-1',
    body: 'はじめてのメモ',
    createdAt: '2026-11-01T09:00:00.000Z',
    updatedAt: '2026-11-02T10:30:00.000Z',
    ...overrides,
});

const listPage = (overrides: Record<string, unknown> = {}) =>
    render('list', {
        memos: [memo()],
        query: '',
        csrfToken: TOKEN,
        ...overrides,
    });

const detailPage = (
    memoOverrides: Partial<Memo> = {},
    overrides: Record<string, unknown> = {},
) =>
    render('detail', {
        memo: memo(memoOverrides),
        csrfToken: TOKEN,
        ...overrides,
    });

// ---- HTML を読む道具(正規表現で、必要な所だけ取り出す) ----

// ejs が変える 5 つの文字を、元に戻す(ブラウザが読む時と、同じ結果にする)
const decode = (text: string): string =>
    text
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&#34;', '"')
        .replaceAll('&#39;', "'")
        .replaceAll('&amp;', '&');

// タグの属性(name="value")の値を、取り出す
const attributeOf = (attributes: string, name: string): string | undefined => {
    const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes);
    return match?.[1] === undefined ? undefined : decode(match[1]);
};

type Form = {
    method: string;
    action: string;
    // type="hidden" の input の、name → value
    hidden: Record<string, string>;
};

const formsOf = (html: string): Form[] =>
    [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map(
        ([, attributes = '', inner = '']) => ({
            method: (attributeOf(attributes, 'method') ?? 'get').toLowerCase(),
            action: attributeOf(attributes, 'action') ?? '',
            hidden: Object.fromEntries(
                [...inner.matchAll(/<input\b([^>]*)>/g)].flatMap(
                    ([, inputAttributes = '']) =>
                        attributeOf(inputAttributes, 'type') === 'hidden'
                            ? [
                                  [
                                      attributeOf(inputAttributes, 'name') ??
                                          '',
                                      attributeOf(inputAttributes, 'value') ??
                                          '',
                                  ],
                              ]
                            : [],
                ),
            ),
        }),
    );

const postFormsOf = (html: string) =>
    formsOf(html).filter((form) => form.method === 'post');

// textarea の中身を、ブラウザが読むのと同じように読む(最初の改行を 1 つ捨てて、文字を戻す)
const textareaValue = (html: string, name: string): string | undefined => {
    for (const [, attributes = '', inner = ''] of html.matchAll(
        /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g,
    )) {
        if (attributeOf(attributes, 'name') === name)
            return decode(inner.startsWith('\n') ? inner.slice(1) : inner);
    }
    return undefined;
};

// 画面の中の、リンクと、フォームの送り先
const destinationsOf = (html: string): string[] =>
    [...html.matchAll(/\s(?:href|action)="([^"]*)"/g)].map(([, value = '']) =>
        decode(value),
    );

const PAGES: { name: string; html: () => Promise<string> }[] = [
    { name: 'welcome', html: () => render('welcome') },
    { name: 'list', html: () => listPage() },
    { name: 'detail', html: () => detailPage() },
    { name: 'error', html: () => render('error', { message: 'えらー' }) },
];

describe('PAGES メモボードの画面(ejs)', () => {
    describe('どの画面にも言える事', () => {
        it.each(PAGES)('$name: HTML の文書として描ける', async ({ html }) => {
            const text = await html();

            expect(text.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
            expect(text).toContain('<html lang="ja">');
            expect(text).toMatch(/<title>[^<]*メモボード[^<]*<\/title>/);
        });

        it.each(PAGES)(
            '$name: スクリプトを使わない(CSP の script-src は self だけ)',
            async ({ html }) => {
                const text = await html();

                expect(text).not.toMatch(/<script/i);
                // onclick などの、属性の中のスクリプトも、CSP で止められる
                expect(text).not.toMatch(/\son[a-z]+\s*=/i);
                expect(text).not.toMatch(/javascript:/i);
            },
        );

        it.each(PAGES)(
            '$name: リンクとフォームの送り先は、全部、このサイトの中(/ から始まる)',
            async ({ html }) => {
                const destinations = destinationsOf(await html());

                expect(destinations.length).toBeGreaterThan(0);
                for (const destination of destinations) {
                    expect(destination).toMatch(/^\/(?!\/)/);
                }
            },
        );
    });

    describe('welcome(ログイン前のトップ)', () => {
        it('ログインを始めるリンク(/login)がある', async () => {
            const html = await render('welcome');

            expect(destinationsOf(html)).toContain('/login');
        });

        it('フォームは無い(ログイン前は、CSRF トークンも無い)', async () => {
            const html = await render('welcome');

            expect(formsOf(html)).toEqual([]);
        });

        it('メッセージ(flash)を渡せば、出す。HTML は、エスケープする', async () => {
            const html = await render('welcome', {
                flash: '<b>ログアウトしました</b>',
            });

            expect(html).toContain('&lt;b&gt;ログアウトしました&lt;/b&gt;');
            expect(html).not.toContain('<b>');
        });

        it('メッセージ(flash)を渡さなければ、メッセージの欄を出さない', async () => {
            const html = await render('welcome');

            expect(html).not.toContain('role="status"');
        });
    });

    describe('list(メモ一覧)', () => {
        describe('メモの表示', () => {
            it('メモの本文を出して、詳細画面(/detail/<id>)へのリンクにする', async () => {
                const html = await listPage({
                    memos: [memo({ id: 'abc-1', body: '牛乳を買う' })],
                });

                expect(html).toContain('牛乳を買う');
                expect(destinationsOf(html)).toContain('/detail/abc-1');
            });

            it('複数のメモは、渡された順番のまま並ぶ', async () => {
                const html = await listPage({
                    memos: [
                        memo({ id: 'a', body: 'ひとつめ' }),
                        memo({ id: 'b', body: 'ふたつめ' }),
                        memo({ id: 'c', body: 'みっつめ' }),
                    ],
                });

                const positions = ['ひとつめ', 'ふたつめ', 'みっつめ'].map(
                    (body) => html.indexOf(body),
                );
                expect(positions.every((p) => p >= 0)).toBe(true);
                expect(positions).toEqual([...positions].sort((a, b) => a - b));
            });

            it('更新日時を出す', async () => {
                const html = await listPage({
                    memos: [memo({ updatedAt: '2026-11-02T10:30:00.000Z' })],
                });

                expect(html).toContain(
                    '<time datetime="2026-11-02T10:30:00.000Z">',
                );
            });

            it('id の中の、特別な文字は、URL として安全な形にする(別の道に変えられない)', async () => {
                const html = await listPage({
                    memos: [memo({ id: 'a/../b?x=1#y"z' })],
                });

                expect(destinationsOf(html)).toContain(
                    `/detail/${encodeURIComponent('a/../b?x=1#y"z')}`,
                );
                expect(html).not.toContain('/detail/a/../b');
            });

            it.each([
                '<script>alert(1)</script>',
                '<img src=x onerror=alert(1)>',
                '"><svg onload=alert(1)>',
            ])('本文の中の HTML は、エスケープして出す: %s', async (body) => {
                const html = await listPage({ memos: [memo({ body })] });

                expect(html).not.toContain(body);
                expect(html).not.toMatch(/<script/i);
                expect(html).not.toMatch(/<img/i);
                expect(html).not.toMatch(/<svg/i);
            });
        });

        describe('メモが無い時', () => {
            it('検索していなければ、「まだメモがありません」を出す', async () => {
                const html = await listPage({ memos: [] });

                expect(html).toContain('まだメモがありません');
                expect(html).not.toContain('合うメモはありません');
                expect(html).not.toContain('<ul');
            });

            it('検索していれば、「合うメモはありません」と、検索語を出す(エスケープして)', async () => {
                const html = await listPage({
                    memos: [],
                    query: '<i>みかん</i>',
                });

                expect(html).toContain('合うメモはありません');
                expect(html).toContain('&lt;i&gt;みかん&lt;/i&gt;');
                expect(html).not.toContain('まだメモがありません');
                expect(html).not.toContain('<i>');
            });

            it('検索していれば、検索をやめるリンク(/)がある', async () => {
                const html = await listPage({ memos: [], query: 'みかん' });

                expect(destinationsOf(html)).toContain('/');
                expect(html).toContain('検索をやめる');
            });
        });

        describe('検索', () => {
            it('検索の欄は、GET で / に送る。名前は q', async () => {
                const html = await listPage();
                const search = formsOf(html).find(
                    (form) => form.method === 'get',
                );

                expect(search?.action).toBe('/');
                expect(html).toMatch(/<input\b[^>]*\bname="q"/);
                expect(html).toMatch(/<input\b[^>]*\btype="search"/);
            });

            it('検索の欄には、CSRF トークンを入れない(GET は、URL に出て、漏れるので)', async () => {
                const html = await listPage();
                const search = formsOf(html).find(
                    (form) => form.method === 'get',
                );

                expect(search?.hidden).toEqual({});
            });

            it('検索の欄は、検索語が入った状態になる(エスケープして)', async () => {
                const html = await listPage({ query: 'a" onfocus="alert(1)' });

                expect(html).toMatch(
                    /<input\b[^>]*\bname="q"[^>]*\bvalue="a&#34; onfocus=&#34;alert\(1\)"/,
                );
            });

            it('検索語が無ければ、検索の欄は空', async () => {
                const html = await listPage({ query: '' });

                expect(html).toMatch(/<input\b[^>]*\bname="q"[^>]*\bvalue=""/);
            });

            it('検索の欄の文字数の上限は 200', async () => {
                const html = await listPage();

                expect(html).toMatch(
                    /<input\b[^>]*\bname="q"[^>]*\bmaxlength="200"/,
                );
            });

            it('検索していれば、見つかった件数を出す', async () => {
                const html = await listPage({
                    memos: [memo({ id: 'a' }), memo({ id: 'b' })],
                    query: 'メモ',
                });

                expect(html).toMatch(/id="result-count"[^>]*>\s*2 件/);
            });

            it('検索していなければ、件数は出さない', async () => {
                const html = await listPage({ query: '' });

                expect(html).not.toContain('result-count');
            });
        });

        describe('フォーム', () => {
            it('メモの作成は、POST で / に送る。CSRF トークンが入る', async () => {
                const html = await listPage();
                const create = postFormsOf(html).find(
                    (form) => form.action === '/',
                );

                expect(create).toBeDefined();
                expect(create?.hidden['_csrf']).toBe(TOKEN);
            });

            it('作成の欄は、name が body の textarea。必須で、上限は 10000 文字', async () => {
                const html = await listPage();

                expect(html).toMatch(
                    /<textarea\b(?=[^>]*\bname="body")(?=[^>]*\brequired)(?=[^>]*\bmaxlength="10000")[^>]*>\s*<\/textarea>/,
                );
            });

            it('ログアウトは、POST で /logout に送る。CSRF トークンが入る', async () => {
                const html = await listPage();
                const logout = postFormsOf(html).find(
                    (form) => form.action === '/logout',
                );

                expect(logout).toBeDefined();
                expect(logout?.hidden['_csrf']).toBe(TOKEN);
            });

            it('POST のフォームは全部で 2 つ(作成とログアウト)で、全部に同じトークンが入る', async () => {
                const forms = postFormsOf(await listPage());

                expect(forms.map((form) => form.action).sort()).toEqual([
                    '/',
                    '/logout',
                ]);
                for (const form of forms)
                    expect(form.hidden['_csrf']).toBe(TOKEN);
            });

            it('CSRF トークンの中の特別な文字は、エスケープされる(属性から飛び出せない)', async () => {
                const html = await listPage({
                    csrfToken: 'a"><script>x</script>',
                });

                expect(html).not.toMatch(/<script/i);
                for (const form of postFormsOf(html))
                    expect(form.hidden['_csrf']).toBe('a"><script>x</script>');
            });
        });

        describe('メッセージ(flash)', () => {
            it('渡せば、出す。HTML は、エスケープする', async () => {
                const html = await listPage({ flash: '<b>追加しました</b>' });

                expect(html).toContain('role="status"');
                expect(html).toContain('&lt;b&gt;追加しました&lt;/b&gt;');
                expect(html).not.toContain('<b>');
            });

            it('渡さなければ、メッセージの欄を出さない', async () => {
                const html = await listPage();

                expect(html).not.toContain('role="status"');
            });
        });
    });

    describe('detail(メモの表示、編集、削除)', () => {
        describe('表示', () => {
            it('作成日時と更新日時を出す', async () => {
                const html = await detailPage({
                    createdAt: '2026-11-01T09:00:00.000Z',
                    updatedAt: '2026-11-02T10:30:00.000Z',
                });

                expect(html).toContain(
                    '<time datetime="2026-11-01T09:00:00.000Z">',
                );
                expect(html).toContain(
                    '<time datetime="2026-11-02T10:30:00.000Z">',
                );
            });

            it('一覧へ戻るリンク(/)がある(ヘッダーのリンクとは別に)', async () => {
                const html = await detailPage();

                expect(html).toMatch(/<a href="\/">[^<]*メモ一覧へ[^<]*<\/a>/);
            });

            it('メッセージ(flash)を渡せば出す。渡さなければ、欄を出さない', async () => {
                const withFlash = await detailPage(
                    {},
                    { flash: '保存しました' },
                );
                const without = await detailPage();

                expect(withFlash).toContain('保存しました');
                expect(withFlash).toContain('role="status"');
                expect(without).not.toContain('role="status"');
            });

            it('メッセージ(flash)の中の HTML は、エスケープして出す', async () => {
                const html = await detailPage(
                    {},
                    { flash: '<b>保存しました</b>' },
                );

                expect(html).toContain('&lt;b&gt;保存しました&lt;/b&gt;');
                expect(html).not.toContain('<b>');
            });
        });

        describe('本文の欄(編集)', () => {
            it.each([
                { name: '普通の文', body: 'はじめてのメモ' },
                { name: '複数行', body: '1行目\n2行目\n\n4行目' },
                { name: '改行で始まる', body: '\n最初が改行' },
                { name: '改行が 2 つ続いて始まる', body: '\n\n最初が空行' },
                { name: '空白で始まる', body: '   先頭に空白' },
                { name: '記号とクォート', body: `a & b < c > d "e" 'f'` },
                { name: '日本語と絵文字', body: '日本語 😀' },
                {
                    name: 'textarea を閉じるタグ',
                    body: '</textarea><script>alert(1)</script>',
                },
                {
                    name: 'エスケープ済みに見える文字',
                    body: '&lt;b&gt; &amp; &#34;',
                },
            ])(
                'ブラウザが読んだ結果が、元の本文と同じになる: $name',
                async ({ body }) => {
                    const html = await detailPage({ body });

                    expect(textareaValue(html, 'body')).toBe(body);
                },
            );

            it('本文に、textarea を閉じるタグがあっても、スクリプトは出てこない', async () => {
                const html = await detailPage({
                    body: '</textarea><script>alert(1)</script>',
                });

                expect(html).not.toMatch(/<script/i);
            });

            it('本文の欄は、必須で、上限は 10000 文字', async () => {
                const html = await detailPage();

                expect(html).toMatch(
                    /<textarea\b(?=[^>]*\bname="body")(?=[^>]*\brequired)(?=[^>]*\bmaxlength="10000")/,
                );
            });
        });

        describe('フォーム', () => {
            it('保存は、POST で /detail/<id> に送る。action=update と、CSRF トークンが入る', async () => {
                const html = await detailPage({ id: 'abc-1' });
                const update = postFormsOf(html).find(
                    (form) => form.hidden['action'] === 'update',
                );

                expect(update?.action).toBe('/detail/abc-1');
                expect(update?.hidden['_csrf']).toBe(TOKEN);
            });

            it('削除は、POST で /detail/<id> に送る。action=delete と、CSRF トークンが入る', async () => {
                const html = await detailPage({ id: 'abc-1' });
                const remove = postFormsOf(html).find(
                    (form) => form.hidden['action'] === 'delete',
                );

                expect(remove?.action).toBe('/detail/abc-1');
                expect(remove?.hidden['_csrf']).toBe(TOKEN);
            });

            it('削除は、確認のために、折りたたみ(details)の中に入っている(スクリプト無しで)', async () => {
                const html = await detailPage();

                expect(html).toMatch(
                    /<details\b[^>]*>[\s\S]*<form\b[\s\S]*name="action"\s+value="delete"[\s\S]*<\/form>[\s\S]*<\/details>/,
                );
            });

            it('ログアウトは、POST で /logout に送る。CSRF トークンが入る', async () => {
                const html = await detailPage();
                const logout = postFormsOf(html).find(
                    (form) => form.action === '/logout',
                );

                expect(logout?.hidden['_csrf']).toBe(TOKEN);
            });

            it('POST のフォームは全部で 3 つ(保存、削除、ログアウト)で、全部に同じトークンが入る', async () => {
                const forms = postFormsOf(await detailPage({ id: 'abc-1' }));

                expect(forms.map((form) => form.action).sort()).toEqual([
                    '/detail/abc-1',
                    '/detail/abc-1',
                    '/logout',
                ]);
                for (const form of forms)
                    expect(form.hidden['_csrf']).toBe(TOKEN);
            });

            it('CSRF トークンの中の特別な文字は、エスケープされる(3 つのフォームとも、属性から飛び出せない)', async () => {
                const html = await detailPage(
                    {},
                    { csrfToken: 'a"><script>x</script>' },
                );
                const forms = postFormsOf(html);

                expect(html).not.toMatch(/<script/i);
                expect(forms).toHaveLength(3);
                for (const form of forms)
                    expect(form.hidden['_csrf']).toBe('a"><script>x</script>');
            });

            it('id の中の特別な文字は、URL として安全な形にする', async () => {
                const html = await detailPage({ id: 'a/../b?x=1#y"z' });
                const expected = `/detail/${encodeURIComponent('a/../b?x=1#y"z')}`;
                const actions = postFormsOf(html)
                    .map((form) => form.action)
                    .filter((action) => action !== '/logout');

                expect(actions).toEqual([expected, expected]);
            });
        });
    });

    describe('error(エラー画面)', () => {
        it('メッセージを出して、トップ(/)へ戻るリンクがある', async () => {
            const html = await render('error', {
                message: '見せたいメッセージ',
            });

            expect(html).toMatch(/id="message"[^>]*>見せたいメッセージ</);
            expect(destinationsOf(html)).toContain('/');
        });

        it('メッセージの中の HTML は、エスケープして出す', async () => {
            const html = await render('error', {
                message: '<script>alert(1)</script>',
            });

            expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
            expect(html).not.toMatch(/<script/i);
        });

        it('message だけで描ける(status などは、要らない)', async () => {
            await expect(render('error', { message: 'x' })).resolves.toContain(
                '<html',
            );
        });

        it('フォームは無い', async () => {
            const html = await render('error', { message: 'x' });

            expect(formsOf(html)).toEqual([]);
        });
    });

    describe('本物のサーバーを通した時(セキュリティヘッダーと一緒に)', () => {
        const withServer = async (
            run: (baseUrl: string) => Promise<void>,
        ): Promise<void> => {
            const server = await startServer(
                createPageTestApp((app) => {
                    app.get('/__page/list', (_req, res) => {
                        res.render('list', {
                            memos: [memo()],
                            query: '',
                            csrfToken: TOKEN,
                        });
                    });
                    app.get('/__page/detail', (_req, res) => {
                        res.render('detail', {
                            memo: memo(),
                            csrfToken: TOKEN,
                        });
                    });
                    app.get('/__page/welcome', (_req, res) => {
                        res.render('welcome');
                    });
                }),
            );
            try {
                await run(server.baseUrl);
            } finally {
                await server.close();
            }
        };

        it.each(['list', 'detail', 'welcome'])(
            '%s: 200 の HTML で返る',
            async (name) => {
                await withServer(async (baseUrl) => {
                    const response = await createClient(baseUrl).get(
                        `/__page/${name}`,
                    );

                    expect(response.status).toBe(200);
                    expect(response.headers.get('content-type')).toMatch(
                        /^text\/html/,
                    );
                });
            },
        );

        it('画面の <style> は、CSP の style-src が許している(インラインのスタイル)', async () => {
            await withServer(async (baseUrl) => {
                const response =
                    await createClient(baseUrl).get('/__page/list');
                const csp =
                    response.headers.get('content-security-policy') ?? '';
                const styleSrc = csp
                    .split(';')
                    .map((directive) => directive.trim())
                    .find((directive) => directive.startsWith('style-src'));

                expect(response.text).toContain('<style>');
                expect(styleSrc).toContain("'unsafe-inline'");
            });
        });
    });
});
