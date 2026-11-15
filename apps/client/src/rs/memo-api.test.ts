import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    sendJson,
    startStubServer,
    type StubHandler,
    type StubServer,
} from '../test-utils/stub-server.js';
import { createMemoApi, type MemoApi } from './memo-api.js';

// JWT のような、ドットで区切った形(1 つの文字列として書かない)
const TOKEN = ['header-part', 'payload-part', 'signature_part'].join('.');
const ID = '3f9c1f0e-8a52-4a8d-9d38-2f6f3f2f0a11';

const memo = (overrides: Record<string, unknown> = {}) => ({
    id: ID,
    body: '牛乳を買う',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-02T00:00:00.000Z',
    ...overrides,
});

let respond: StubHandler;
let server: StubServer;
let api: MemoApi;

beforeEach(async () => {
    respond = (_request, response) => sendJson(response, 200, memo());
    server = await startStubServer((request, response) =>
        respond(request, response),
    );
    api = createMemoApi({ baseUrl: server.baseUrl });
});

afterEach(async () => {
    await server.close();
});

const lastRequest = () => {
    const request = server.requests.at(-1);
    if (!request) throw new Error('リクエストが届いていません');
    return request;
};

// 5 つの操作(失敗の分け方は、全部の操作で同じ)
const OPERATIONS = [
    { name: 'list', run: () => api.list(TOKEN) },
    { name: 'get', run: () => api.get(TOKEN, ID) },
    { name: 'create', run: () => api.create(TOKEN, 'x') },
    { name: 'update', run: () => api.update(TOKEN, ID, 'x') },
    { name: 'delete', run: () => api.delete(TOKEN, ID) },
];

describe('MEMO-API RS の API を呼ぶ(返事を、画面の動きに直す)', () => {
    describe('createMemoApi', () => {
        it.each([
            { name: '空文字', value: '' },
            { name: '絶対 URL ではない', value: '/memos' },
            { name: 'URL ではない', value: 'not a url' },
            { name: 'http と https 以外', value: 'ftp://example.com' },
        ])('baseUrl が $name なら、作る時に RangeError', ({ value }) => {
            expect(() => createMemoApi({ baseUrl: value })).toThrow(RangeError);
        });
    });

    describe('送るリクエスト', () => {
        it('list: GET /memos。Authorization: Bearer が付く。本文は無い', async () => {
            await api.list(TOKEN);

            const request = lastRequest();
            expect(request.method).toBe('GET');
            expect(request.url).toBe('/memos');
            expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
            expect(request.headers['accept']).toContain('application/json');
            expect(request.body).toBe('');
        });

        it('get: GET /memos/:id', async () => {
            await api.get(TOKEN, ID);

            expect(lastRequest().method).toBe('GET');
            expect(lastRequest().url).toBe(`/memos/${ID}`);
            expect(lastRequest().headers['authorization']).toBe(
                `Bearer ${TOKEN}`,
            );
        });

        it('create: POST /memos。本文は、{ body } の JSON', async () => {
            await api.create(TOKEN, '牛乳を買う');

            const request = lastRequest();
            expect(request.method).toBe('POST');
            expect(request.url).toBe('/memos');
            expect(request.headers['content-type']).toBe('application/json');
            expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
            expect(JSON.parse(request.body)).toEqual({ body: '牛乳を買う' });
        });

        it('update: PUT /memos/:id。本文は、{ body } の JSON', async () => {
            await api.update(TOKEN, ID, 'changed');

            const request = lastRequest();
            expect(request.method).toBe('PUT');
            expect(request.url).toBe(`/memos/${ID}`);
            expect(request.headers['content-type']).toBe('application/json');
            expect(JSON.parse(request.body)).toEqual({ body: 'changed' });
        });

        it('delete: DELETE /memos/:id。本文は無い', async () => {
            respond = (_r, res) => {
                res.writeHead(204);
                res.end();
            };

            await api.delete(TOKEN, ID);

            const request = lastRequest();
            expect(request.method).toBe('DELETE');
            expect(request.url).toBe(`/memos/${ID}`);
            expect(request.body).toBe('');
            expect(request.headers['content-type']).toBeUndefined();
        });

        it.each([
            { name: '引用符と、バックスラッシュ', body: '"a"\\b' },
            { name: '改行', body: 'line1\nline2\r\n' },
            { name: '絵文字と日本語', body: '😀 日本語' },
            { name: '制御文字', body: 'a\u0001b' },
            { name: '{ や }', body: '{"owner":"x"}' },
        ])(
            '本文に $name があっても、JSON として、そのまま届く(body だけの JSON)',
            async ({ body }) => {
                await api.create(TOKEN, body);

                expect(JSON.parse(lastRequest().body)).toEqual({ body });
            },
        );

        it('Cookie は、送らない', async () => {
            await api.list(TOKEN);

            expect(lastRequest().headers['cookie']).toBeUndefined();
        });
    });

    describe('baseUrl', () => {
        it.each([
            { name: '末尾に / がある', suffix: '/' },
            { name: 'パスが付いている', suffix: '/api' },
            { name: 'パスが付いていて、末尾に / がある', suffix: '/api/' },
            { name: 'パスが、2 段', suffix: '/a/b' },
        ])('$name: その下の /memos を呼ぶ', async ({ suffix }) => {
            const custom = createMemoApi({
                baseUrl: `${server.baseUrl}${suffix}`,
            });

            await custom.list(TOKEN);

            const prefix = suffix.replace(/\/+$/, '');
            expect(lastRequest().url).toBe(`${prefix}/memos`);
        });
    });

    describe('id の扱い(画面の URL の値を、そのまま RS の道に使わない)', () => {
        it.each([
            { name: 'UUID', id: ID },
            { name: '短い', id: 'memo-1' },
            { name: '英数字と _ -', id: 'abc_DEF-123' },
            { name: '128 文字(上限)', id: 'a'.repeat(128) },
        ])('使える id: $name', async ({ id }) => {
            await api.get(TOKEN, id);

            expect(lastRequest().url).toBe(`/memos/${id}`);
        });

        it.each([
            { name: '空文字', id: '' },
            { name: '..', id: '..' },
            { name: '.', id: '.' },
            { name: '%2e%2e', id: '%2e%2e' },
            { name: 'スラッシュ', id: 'a/b' },
            { name: '../ から始まる', id: '../admin' },
            { name: '?', id: 'a?b=c' },
            { name: '#', id: 'a#b' },
            { name: '空白', id: 'a b' },
            { name: '%', id: 'a%2Fb' },
            { name: '日本語', id: 'メモ' },
            { name: '改行', id: 'a\nb' },
            { name: '129 文字(上限の 1 つ上)', id: 'a'.repeat(129) },
        ])(
            '使えない id($name)は、RS を呼ばずに、not_found(get、update、delete)',
            async ({ id }) => {
                const results = [
                    await api.get(TOKEN, id),
                    await api.update(TOKEN, id, 'x'),
                    await api.delete(TOKEN, id),
                ];

                for (const result of results)
                    expect(result).toEqual({ ok: false, failure: 'not_found' });
                expect(server.requests).toHaveLength(0);
            },
        );
    });

    describe('成功(2xx)', () => {
        it('list: メモの配列が返る(空でも良い)', async () => {
            respond = (_r, res) =>
                sendJson(res, 200, {
                    memos: [memo(), memo({ id: 'second', body: '2' })],
                });

            const result = await api.list(TOKEN);

            expect(result).toEqual({
                ok: true,
                data: [memo(), memo({ id: 'second', body: '2' })],
            });
            respond = (_r, res) => sendJson(res, 200, { memos: [] });
            expect(await api.list(TOKEN)).toEqual({ ok: true, data: [] });
        });

        it('get: メモが返る', async () => {
            expect(await api.get(TOKEN, ID)).toEqual({
                ok: true,
                data: memo(),
            });
        });

        it('create: 201 でも、メモが返る', async () => {
            respond = (_r, res) => sendJson(res, 201, memo());

            expect(await api.create(TOKEN, 'x')).toEqual({
                ok: true,
                data: memo(),
            });
        });

        it('update: メモが返る', async () => {
            expect(await api.update(TOKEN, ID, 'x')).toEqual({
                ok: true,
                data: memo(),
            });
        });

        it('delete: 204(本文なし)で、成功(data は undefined)', async () => {
            respond = (_r, res) => {
                res.writeHead(204);
                res.end();
            };

            expect(await api.delete(TOKEN, ID)).toEqual({
                ok: true,
                data: undefined,
            });
        });

        it('メモに、知らない項目(owner など)があっても、4 つの項目だけを返す', async () => {
            respond = (_r, res) =>
                sendJson(res, 200, memo({ owner: 'alice', secret: 'x' }));

            const result = await api.get(TOKEN, ID);

            expect(result).toEqual({ ok: true, data: memo() });
            if (result.ok)
                expect(Object.keys(result.data).sort()).toEqual([
                    'body',
                    'createdAt',
                    'id',
                    'updatedAt',
                ]);
        });
    });

    describe('成功の返事が、使えない形: unavailable', () => {
        const badLists = [
            { name: '{ memos } が無い', body: {} },
            { name: 'memos が配列ではない', body: { memos: 'x' } },
            { name: '全体が配列', body: [memo()] },
            { name: '全体が null', body: null },
            {
                name: '項目の id が無い',
                body: { memos: [memo({ id: undefined })] },
            },
            {
                name: '項目の body が数値',
                body: { memos: [memo({ body: 1 })] },
            },
            { name: '項目が配列', body: { memos: [[]] } },
            {
                name: '1 つだけ、おかしい',
                body: { memos: [memo(), { id: 'x' }] },
            },
        ];

        it.each(badLists)('list: $name', async ({ body }) => {
            respond = (_r, res) => sendJson(res, 200, body);

            expect(await api.list(TOKEN)).toEqual({
                ok: false,
                failure: 'unavailable',
            });
        });

        const badMemos = [
            { name: '配列', body: [memo()] },
            { name: 'null', body: null },
            { name: 'id が無い', body: memo({ id: undefined }) },
            { name: 'body が無い', body: memo({ body: undefined }) },
            { name: 'createdAt が数値', body: memo({ createdAt: 1 }) },
            { name: 'updatedAt が無い', body: memo({ updatedAt: undefined }) },
        ];

        it.each(badMemos)('get、create、update: $name', async ({ body }) => {
            respond = (_r, res) => sendJson(res, 200, body);

            for (const result of [
                await api.get(TOKEN, ID),
                await api.create(TOKEN, 'x'),
                await api.update(TOKEN, ID, 'x'),
            ])
                expect(result).toEqual({ ok: false, failure: 'unavailable' });
        });

        it.each([
            { name: 'JSON ではない', raw: 'not json' },
            { name: '空の本文', raw: '' },
        ])('メモを返すはずの 200 で、本文が $name', async ({ raw }) => {
            respond = (_r, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(raw);
            };

            for (const result of [
                await api.list(TOKEN),
                await api.get(TOKEN, ID),
                await api.create(TOKEN, 'x'),
                await api.update(TOKEN, ID, 'x'),
            ])
                expect(result).toEqual({ ok: false, failure: 'unavailable' });
        });
    });

    describe('401: unauthorized(セッションを捨てて、再ログイン)', () => {
        it.each(OPERATIONS)('$name', async ({ run }) => {
            respond = (_r, res) =>
                sendJson(
                    res,
                    401,
                    { error: 'invalid_token' },
                    {
                        'WWW-Authenticate':
                            'Bearer realm="simple-memo", error="invalid_token"',
                    },
                );

            expect(await run()).toEqual({ ok: false, failure: 'unauthorized' });
        });

        it('本文が無くても、unauthorized', async () => {
            respond = (_r, res) => {
                res.writeHead(401);
                res.end();
            };

            expect(await api.list(TOKEN)).toEqual({
                ok: false,
                failure: 'unauthorized',
            });
        });
    });

    describe('403', () => {
        const insufficientHeader =
            'Bearer realm="simple-memo", scope="write", error="insufficient_scope"';

        it.each(OPERATIONS)(
            '$name: WWW-Authenticate に error="insufficient_scope": insufficient_scope',
            async ({ run }) => {
                respond = (_r, res) => {
                    res.writeHead(403, {
                        'WWW-Authenticate': insufficientHeader,
                    });
                    res.end();
                };

                expect(await run()).toEqual({
                    ok: false,
                    failure: 'insufficient_scope',
                });
            },
        );

        it('本文の error が insufficient_scope でも、insufficient_scope(ヘッダーが無い時)', async () => {
            respond = (_r, res) =>
                sendJson(res, 403, { error: 'insufficient_scope' });

            expect(await api.create(TOKEN, 'x')).toEqual({
                ok: false,
                failure: 'insufficient_scope',
            });
        });

        it.each(OPERATIONS)(
            '$name: error が forbidden(他人のメモなど): forbidden',
            async ({ run }) => {
                respond = (_r, res) =>
                    sendJson(res, 403, { error: 'forbidden' });

                expect(await run()).toEqual({
                    ok: false,
                    failure: 'forbidden',
                });
            },
        );

        it.each([
            { name: '本文もヘッダーも無い', headers: {}, body: undefined },
            {
                name: 'realm だけのヘッダー',
                headers: { 'WWW-Authenticate': 'Bearer realm="simple-memo"' },
                body: undefined,
            },
            {
                name: 'invalid_token のヘッダー',
                headers: {
                    'WWW-Authenticate':
                        'Bearer realm="x", error="invalid_token"',
                },
                body: undefined,
            },
            {
                name: '本文が JSON ではない',
                headers: {},
                body: '<html>forbidden</html>',
            },
        ])('その他の 403($name): forbidden', async ({ headers, body }) => {
            respond = (_r, res) => {
                res.writeHead(403, headers);
                res.end(body);
            };

            expect(await api.get(TOKEN, ID)).toEqual({
                ok: false,
                failure: 'forbidden',
            });
        });
    });

    describe('404 と、400 など', () => {
        it.each(OPERATIONS)('$name: 404 は not_found', async ({ run }) => {
            respond = (_r, res) => sendJson(res, 404, { error: 'not_found' });

            expect(await run()).toEqual({ ok: false, failure: 'not_found' });
        });

        it('400: invalid_request。RS の説明(error_description)が、message に入る', async () => {
            respond = (_r, res) =>
                sendJson(res, 400, {
                    error: 'invalid_request',
                    error_description:
                        'body must be a string of 1 to 10000 characters',
                });

            expect(await api.create(TOKEN, '')).toEqual({
                ok: false,
                failure: 'invalid_request',
                message: 'body must be a string of 1 to 10000 characters',
            });
        });

        it('400 で、説明が無ければ、message は付かない', async () => {
            respond = (_r, res) =>
                sendJson(res, 400, { error: 'invalid_request' });

            expect(await api.update(TOKEN, ID, 'x')).toEqual({
                ok: false,
                failure: 'invalid_request',
            });
        });

        it.each([
            { name: '日本語', value: '内容が正しくありません' },
            { name: 'ダブルクォート', value: 'a "b"' },
            { name: '改行', value: 'a\nb' },
            { name: '数値', value: 1 },
            { name: '空文字', value: '' },
        ])(
            '説明が使えない形($name)なら、message を付けない',
            async ({ value }) => {
                respond = (_r, res) =>
                    sendJson(res, 400, {
                        error: 'invalid_request',
                        error_description: value,
                    });

                expect(await api.create(TOKEN, 'x')).toEqual({
                    ok: false,
                    failure: 'invalid_request',
                });
            },
        );

        it.each([400, 413, 415])('%i は invalid_request', async (status) => {
            respond = (_r, res) =>
                sendJson(res, status, { error: 'invalid_request' });

            expect(await api.create(TOKEN, 'x')).toMatchObject({
                ok: false,
                failure: 'invalid_request',
            });
        });
    });

    describe('それ以外: unavailable(エラー画面。リトライしない)', () => {
        it.each([500, 502, 503, 504])('HTTP %i', async (status) => {
            respond = (_r, res) => {
                res.writeHead(status, { 'Content-Type': 'text/html' });
                res.end('<html>error</html>');
            };

            expect(await api.list(TOKEN)).toEqual({
                ok: false,
                failure: 'unavailable',
            });
        });

        it.each([300, 304, 405, 409, 418, 429])(
            '想定していない status(HTTP %i): 3xx と、想定していない 4xx',
            async (status) => {
                respond = (_r, res) => sendJson(res, status, { error: 'x' });

                expect(await api.get(TOKEN, ID)).toEqual({
                    ok: false,
                    failure: 'unavailable',
                });
            },
        );

        it('メモの形の本文が付いていても、2xx 以外(300)は、成功にしない', async () => {
            respond = (_r, res) => sendJson(res, 300, memo());

            expect(await api.get(TOKEN, ID)).toEqual({
                ok: false,
                failure: 'unavailable',
            });
        });

        it('転送(302)は辿らない。転送先には、トークンを送らない', async () => {
            const target = await startStubServer((_r, res) =>
                sendJson(res, 200, memo()),
            );
            respond = (_r, res) => {
                res.writeHead(302, { Location: `${target.baseUrl}/memos/x` });
                res.end();
            };

            try {
                expect(await api.get(TOKEN, ID)).toEqual({
                    ok: false,
                    failure: 'unavailable',
                });
                expect(target.requests).toHaveLength(0);
            } finally {
                await target.close();
            }
        });

        it('つながらない(サーバーが無い)ときは、例外を投げずに unavailable', async () => {
            const dead = await startStubServer(() => {});
            const deadApi = createMemoApi({ baseUrl: dead.baseUrl });
            await dead.close();

            for (const result of [
                await deadApi.list(TOKEN),
                await deadApi.get(TOKEN, ID),
                await deadApi.create(TOKEN, 'x'),
                await deadApi.update(TOKEN, ID, 'x'),
                await deadApi.delete(TOKEN, ID),
            ])
                expect(result).toEqual({ ok: false, failure: 'unavailable' });
        });

        it('返事が来なければ、timeoutMs で諦めて、unavailable', async () => {
            respond = () => {
                // 返事を返さない
            };
            const impatient = createMemoApi({
                baseUrl: server.baseUrl,
                timeoutMs: 150,
            });

            const started = Date.now();
            const result = await impatient.list(TOKEN);

            expect(result).toEqual({ ok: false, failure: 'unavailable' });
            expect(Date.now() - started).toBeLessThan(3000);
        });

        it('トークンに、ヘッダーに使えない文字(改行)があっても、例外を投げずに unavailable(何も送らない)', async () => {
            const result = await api.list('abc\r\nX-Evil: 1');

            expect(result).toEqual({ ok: false, failure: 'unavailable' });
            expect(server.requests).toHaveLength(0);
        });

        it.each(OPERATIONS)(
            '$name: リトライはしない(1 回だけ送る)',
            async ({ run }) => {
                respond = (_r, res) => sendJson(res, 503, { error: 'x' });

                await run();

                expect(server.requests).toHaveLength(1);
            },
        );
    });

    describe('アクセストークンを、結果に入れない', () => {
        it.each([
            { name: '401', status: 401 },
            { name: '403', status: 403 },
            { name: '404', status: 404 },
            { name: '400', status: 400 },
            { name: '500', status: 500 },
        ])('$name の結果に、トークンは入らない', async ({ status }) => {
            respond = (request, res) =>
                sendJson(res, status, {
                    error: 'x',
                    echoed: request.headers['authorization'],
                });

            for (const { run } of OPERATIONS)
                expect(JSON.stringify(await run())).not.toContain(TOKEN);
        });
    });
});
