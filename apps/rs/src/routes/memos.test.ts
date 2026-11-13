import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_BODY_LENGTH } from '../lib/memo-input.js';
import { authenticate } from '../middleware/authenticate.js';
import { errorHandler, notFoundHandler } from '../middleware/error-handler.js';
import { createMemoryMemoStore } from '../stores/memory-memo-store.js';
import type { MemoStore } from '../stores/memo-store.js';
import { startServer, type TestServer } from '../test-utils/http.js';
import {
    createTestKeyPair,
    signToken,
    TEST_AUDIENCE,
    TEST_ISSUER,
    TEST_NOW,
} from '../test-utils/tokens.js';
import { createMemosRouter } from './memos.js';

const REALM = 'simple-memo';
const START = Date.UTC(2030, 0, 1, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();
const INVALID_BODY = `body must be a string of 1 to ${MAX_BODY_LENGTH} characters`;

const keys = createTestKeyPair();

// メモの日時に使う時計(ミリ秒)と、メモの id の連番
const memoClock = { now: START };
let sequence = 0;

const newStore = (): MemoStore =>
    createMemoryMemoStore({
        now: () => memoClock.now,
        generateId: () => `memo-${++sequence}`,
    });

function createTestApp(store: MemoStore) {
    const app = express();
    app.use(
        '/memos',
        authenticate({
            publicKey: keys.publicKey,
            issuer: TEST_ISSUER,
            audience: TEST_AUDIENCE,
            realm: REALM,
            now: () => TEST_NOW + 10,
        }),
        createMemosRouter({ memoStore: store, realm: REALM }),
    );
    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}

let store: MemoStore;
let server: TestServer;

beforeEach(async () => {
    memoClock.now = START;
    sequence = 0;
    store = newStore();
    server = await startServer(createTestApp(store));
});

afterEach(async () => {
    await server.close();
});

const tokenFor = (sub: string, scope: string) =>
    signToken(keys.privateKey, { claims: { sub, scope } });
const ALICE = tokenFor('alice', 'write');
const ALICE_READ_ONLY = tokenFor('alice', 'read');
const BOB = tokenFor('bob', 'write');

type Result = {
    status: number;
    headers: Headers;
    text: string;
    json: Record<string, unknown> | null;
};

// リクエストを送る(json を渡すと、JSON にして送る。raw は、そのまま送る)
async function call(
    method: string,
    path: string,
    init: {
        token?: string;
        json?: unknown;
        raw?: string;
        contentType?: string;
    } = {},
): Promise<Result> {
    const body =
        init.raw ??
        (init.json === undefined ? undefined : JSON.stringify(init.json));
    const response = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: {
            ...(init.token === undefined
                ? {}
                : { Authorization: `Bearer ${init.token}` }),
            ...(body === undefined
                ? {}
                : { 'Content-Type': init.contentType ?? 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
    });
    const text = await response.text();
    return {
        status: response.status,
        headers: response.headers,
        text,
        json:
            text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
    };
}

// ストアに、直接メモを入れる(id は memo-1、memo-2、…の順)
const seed = (owner: string, body: string) => store.create({ owner, body });

describe('MEMOS メモの CRUD(/memos)', () => {
    describe('認証と認可(5 つの道、全部)', () => {
        const ROUTES = [
            { name: 'GET /memos', method: 'GET', path: '/memos', write: false },
            {
                name: 'GET /memos/:id',
                method: 'GET',
                path: '/memos/memo-1',
                write: false,
            },
            {
                name: 'POST /memos',
                method: 'POST',
                path: '/memos',
                write: true,
            },
            {
                name: 'PUT /memos/:id',
                method: 'PUT',
                path: '/memos/memo-1',
                write: true,
            },
            {
                name: 'DELETE /memos/:id',
                method: 'DELETE',
                path: '/memos/memo-1',
                write: true,
            },
        ];
        const json = { body: 'changed' };
        const bodyFor = (write: boolean) => (write ? json : undefined);

        beforeEach(async () => {
            await seed('alice', 'original');
        });

        // メモが、元のまま 1 件だけであること
        const expectUntouched = async () => {
            const list = await store.listByOwner('alice');
            expect(list.map((memo) => memo.body)).toEqual(['original']);
            expect(await store.listByOwner('bob')).toEqual([]);
        };

        it.each(ROUTES)(
            '$name: トークンが無ければ、401(何も変わらない)',
            async ({ method, path, write }) => {
                const result = await call(method, path, {
                    json: bodyFor(write),
                });

                expect(result.status).toBe(401);
                expect(result.headers.get('www-authenticate')).toBe(
                    'Bearer realm="simple-memo"',
                );
                await expectUntouched();
            },
        );

        it.each(ROUTES)(
            '$name: トークンが正しくなければ、401(何も変わらない)',
            async ({ method, path, write }) => {
                const bad = signToken(keys.privateKey, {
                    claims: { sub: 'alice', scope: 'write', exp: TEST_NOW + 1 },
                });

                const result = await call(method, path, {
                    token: bad,
                    json: bodyFor(write),
                });

                expect(result.status).toBe(401);
                expect(result.headers.get('www-authenticate')).toContain(
                    'error="invalid_token"',
                );
                await expectUntouched();
            },
        );

        it.each(ROUTES.filter((route) => route.write))(
            '$name: read だけのトークンは、403 insufficient_scope(何も変わらない)',
            async ({ method, path }) => {
                const result = await call(method, path, {
                    token: ALICE_READ_ONLY,
                    json,
                });

                expect(result.status).toBe(403);
                expect(result.headers.get('www-authenticate')).toContain(
                    'error="insufficient_scope"',
                );
                expect(result.headers.get('www-authenticate')).toContain(
                    'scope="write"',
                );
                expect(result.json).toMatchObject({
                    error: 'insufficient_scope',
                });
                await expectUntouched();
            },
        );

        it.each(ROUTES.filter((route) => !route.write))(
            '$name: read だけのトークンでも、write のトークンでも、通る',
            async ({ method, path }) => {
                const withRead = await call(method, path, {
                    token: ALICE_READ_ONLY,
                });
                const withWrite = await call(method, path, { token: ALICE });

                expect(withRead.status).toBe(200);
                expect(withWrite.status).toBe(200);
            },
        );

        it.each(ROUTES.filter((route) => !route.write))(
            '$name: read も write も持たないトークンは、403(足りないスコープは read)',
            async ({ method, path }) => {
                const result = await call(method, path, {
                    token: tokenFor('alice', 'admin'),
                });

                expect(result.status).toBe(403);
                expect(result.headers.get('www-authenticate')).toContain(
                    'scope="read"',
                );
            },
        );

        it('認証が先: トークンが無ければ、本文が壊れていても、401', async () => {
            const result = await call('POST', '/memos', {
                raw: '{bad',
            });

            expect(result.status).toBe(401);
        });

        it('認可が先: read だけのトークンなら、本文が壊れていても、403', async () => {
            const result = await call('POST', '/memos', {
                token: ALICE_READ_ONLY,
                raw: '{bad',
            });

            expect(result.status).toBe(403);
        });

        it('認可が先: read だけのトークンは、無い id でも、404 ではなく 403(存在を教えない)', async () => {
            const result = await call('DELETE', '/memos/nothing', {
                token: ALICE_READ_ONLY,
            });

            expect(result.status).toBe(403);
        });
    });

    describe('GET /memos(一覧)', () => {
        it('メモが無ければ、{ memos: [] }', async () => {
            const result = await call('GET', '/memos', { token: ALICE });

            expect(result.status).toBe(200);
            expect(result.headers.get('content-type')).toMatch(
                /^application\/json/,
            );
            expect(result.json).toEqual({ memos: [] });
        });

        it('自分のメモだけが、作った順(古い順)に、並ぶ。持ち主の項目は、載らない', async () => {
            await seed('alice', 'a1');
            memoClock.now = START + 1000;
            await seed('bob', 'b1');
            await seed('alice', 'a2');

            const result = await call('GET', '/memos', { token: ALICE });

            expect(result.status).toBe(200);
            expect(result.json).toEqual({
                memos: [
                    {
                        id: 'memo-1',
                        body: 'a1',
                        createdAt: iso(START),
                        updatedAt: iso(START),
                    },
                    {
                        id: 'memo-3',
                        body: 'a2',
                        createdAt: iso(START + 1000),
                        updatedAt: iso(START + 1000),
                    },
                ],
            });
        });

        it('別の人のトークンでは、その人のメモだけが見える', async () => {
            await seed('alice', 'a1');
            await seed('bob', 'b1');

            const result = await call('GET', '/memos', { token: BOB });

            expect(result.json).toEqual({
                memos: [expect.objectContaining({ id: 'memo-2', body: 'b1' })],
            });
        });
    });

    describe('GET /memos/:id(1 件)', () => {
        it('自分のメモが、返る(持ち主の項目は、載らない)', async () => {
            await seed('alice', 'hello');

            const result = await call('GET', '/memos/memo-1', {
                token: ALICE,
            });

            expect(result.status).toBe(200);
            expect(result.json).toEqual({
                id: 'memo-1',
                body: 'hello',
                createdAt: iso(START),
                updatedAt: iso(START),
            });
        });

        it('無い id は、404', async () => {
            const result = await call('GET', '/memos/nothing', {
                token: ALICE,
            });

            expect(result.status).toBe(404);
            expect(result.json).toEqual({ error: 'not_found' });
        });

        it('別の人のメモは、403(メモの中身も、持ち主も、返事に出さない)', async () => {
            await seed('bob', 'secret-body');

            const result = await call('GET', '/memos/memo-1', {
                token: ALICE,
            });

            expect(result.status).toBe(403);
            expect(result.json).toEqual({ error: 'forbidden' });
            expect(result.text).not.toContain('secret-body');
            expect(result.text).not.toContain('bob');
        });

        it('持ち主の違いの 403 には、WWW-Authenticate は付かない(トークンのスコープの話ではない)', async () => {
            await seed('bob', 'x');

            const result = await call('GET', '/memos/memo-1', {
                token: ALICE,
            });

            expect(result.headers.has('www-authenticate')).toBe(false);
        });

        it.each([
            { name: '変な文字', id: 'a%2Fb' },
            { name: '..', id: '%2E%2E' },
            { name: '長い id', id: 'x'.repeat(1000) },
            { name: '大文字小文字が違う', id: 'MEMO-1' },
        ])('見つからない id は、404: $name', async ({ id }) => {
            await seed('alice', 'hello');

            const result = await call('GET', `/memos/${id}`, {
                token: ALICE,
            });

            expect(result.status).toBe(404);
        });
    });

    describe('POST /memos(作成)', () => {
        it('201 で、作ったメモを返す。Location は、そのメモの道', async () => {
            memoClock.now = START + 5000;

            const result = await call('POST', '/memos', {
                token: ALICE,
                json: { body: 'hello' },
            });

            expect(result.status).toBe(201);
            expect(result.headers.get('location')).toBe('/memos/memo-1');
            expect(result.headers.get('content-type')).toMatch(
                /^application\/json/,
            );
            expect(result.json).toEqual({
                id: 'memo-1',
                body: 'hello',
                createdAt: iso(START + 5000),
                updatedAt: iso(START + 5000),
            });
        });

        it('持ち主は、トークンの sub になる。作ったメモは、GET でも見える', async () => {
            await call('POST', '/memos', {
                token: ALICE,
                json: { body: 'hello' },
            });

            expect((await store.find('memo-1'))?.owner).toBe('alice');
            const get = await call('GET', '/memos/memo-1', { token: ALICE });
            expect(get.json).toMatchObject({ id: 'memo-1', body: 'hello' });
            const bobsList = await call('GET', '/memos', { token: BOB });
            expect(bobsList.json).toEqual({ memos: [] });
        });

        it('リクエストに、owner、id、日時が付いていても、無視する', async () => {
            const result = await call('POST', '/memos', {
                token: ALICE,
                json: {
                    body: 'hello',
                    owner: 'bob',
                    id: 'fixed-id',
                    createdAt: '2000-01-01T00:00:00.000Z',
                    updatedAt: '2000-01-01T00:00:00.000Z',
                },
            });

            expect(result.status).toBe(201);
            expect(result.json).toEqual({
                id: 'memo-1',
                body: 'hello',
                createdAt: iso(START),
                updatedAt: iso(START),
            });
            expect((await store.find('memo-1'))?.owner).toBe('alice');
            expect(await store.find('fixed-id')).toBeNull();
        });

        it('作るたびに、別の id', async () => {
            const a = await call('POST', '/memos', {
                token: ALICE,
                json: { body: 'a' },
            });
            const b = await call('POST', '/memos', {
                token: ALICE,
                json: { body: 'b' },
            });

            expect([a.json?.['id'], b.json?.['id']]).toEqual([
                'memo-1',
                'memo-2',
            ]);
        });

        it.each([
            { name: '最大の文字数ちょうど', body: 'a'.repeat(MAX_BODY_LENGTH) },
            {
                name: '日本語で、最大の文字数',
                body: 'あ'.repeat(MAX_BODY_LENGTH),
            },
            {
                name: '制御文字で、最大の文字数(JSON にすると、6 倍の大きさ)',
                body: '\u0001'.repeat(MAX_BODY_LENGTH),
            },
            { name: '前後の空白と改行', body: '  line1\nline2  ' },
        ])('通る: $name', async ({ body }) => {
            const result = await call('POST', '/memos', {
                token: ALICE,
                json: { body },
            });

            expect(result.status).toBe(201);
            expect(result.json?.['body']).toBe(body);
        });

        describe('入力が正しくない: 400(何も作らない)', () => {
            it.each([
                { name: '空文字', json: { body: '' } },
                { name: 'body が無い', json: {} },
                { name: 'body が数値', json: { body: 1 } },
                { name: 'body が null', json: { body: null } },
                { name: 'body が配列', json: { body: ['a'] } },
                {
                    name: '最大を 1 文字超えている',
                    json: { body: 'a'.repeat(MAX_BODY_LENGTH + 1) },
                },
                { name: '全体が配列', json: [{ body: 'a' }] },
            ])('$name', async ({ json }) => {
                const result = await call('POST', '/memos', {
                    token: ALICE,
                    raw: JSON.stringify(json),
                });

                expect(result.status).toBe(400);
                expect(result.json).toEqual({
                    error: 'invalid_request',
                    error_description: INVALID_BODY,
                });
                expect(result.headers.has('www-authenticate')).toBe(false);
                expect(await store.listByOwner('alice')).toEqual([]);
            });

            it('Content-Type が JSON ではない(本文が読まれない)', async () => {
                const result = await call('POST', '/memos', {
                    token: ALICE,
                    raw: '{"body":"hello"}',
                    contentType: 'text/plain',
                });

                expect(result.status).toBe(400);
                expect(result.json).toMatchObject({ error: 'invalid_request' });
                expect(await store.listByOwner('alice')).toEqual([]);
            });

            it('本文が、まったく無い', async () => {
                const result = await call('POST', '/memos', { token: ALICE });

                expect(result.status).toBe(400);
                expect(await store.listByOwner('alice')).toEqual([]);
            });

            it('JSON が壊れている', async () => {
                const result = await call('POST', '/memos', {
                    token: ALICE,
                    raw: '{bad',
                });

                expect(result.status).toBe(400);
                expect(result.json).toEqual({ error: 'invalid_request' });
                expect(await store.listByOwner('alice')).toEqual([]);
            });

            it.each([
                { name: '文字列', raw: '"hello"' },
                { name: 'null', raw: 'null' },
                { name: '数値', raw: '12' },
            ])(
                'JSON の一番外が、オブジェクトか配列ではない(strict な読み方): $name',
                async ({ raw }) => {
                    const result = await call('POST', '/memos', {
                        token: ALICE,
                        raw,
                    });

                    expect(result.status).toBe(400);
                    expect(await store.listByOwner('alice')).toEqual([]);
                },
            );
        });

        it('本文が大きすぎる(100KB 超え): 413', async () => {
            const result = await call('POST', '/memos', {
                token: ALICE,
                raw: JSON.stringify({ body: 'a'.repeat(200_000) }),
            });

            expect(result.status).toBe(413);
            expect(result.json).toEqual({ error: 'invalid_request' });
            expect(await store.listByOwner('alice')).toEqual([]);
        });

        it('知らない文字コードを名乗ると、415', async () => {
            const result = await call('POST', '/memos', {
                token: ALICE,
                raw: '{"body":"hello"}',
                contentType: 'application/json; charset=foo',
            });

            expect(result.status).toBe(415);
        });
    });

    describe('PUT /memos/:id(更新)', () => {
        it('自分のメモを、書き換えて、200 で返す(更新日時は今、作成日時は、そのまま)', async () => {
            await seed('alice', 'before');
            memoClock.now = START + 60_000;

            const result = await call('PUT', '/memos/memo-1', {
                token: ALICE,
                json: { body: 'after' },
            });

            expect(result.status).toBe(200);
            expect(result.json).toEqual({
                id: 'memo-1',
                body: 'after',
                createdAt: iso(START),
                updatedAt: iso(START + 60_000),
            });
            expect(await store.find('memo-1')).toMatchObject({
                body: 'after',
                owner: 'alice',
            });
        });

        it('リクエストに、owner、id、日時が付いていても、無視する', async () => {
            await seed('alice', 'before');

            const result = await call('PUT', '/memos/memo-1', {
                token: ALICE,
                json: {
                    body: 'after',
                    owner: 'bob',
                    id: 'other-id',
                    createdAt: '2000-01-01T00:00:00.000Z',
                },
            });

            expect(result.status).toBe(200);
            expect(result.json).toMatchObject({
                id: 'memo-1',
                createdAt: iso(START),
            });
            expect((await store.find('memo-1'))?.owner).toBe('alice');
            expect(await store.find('other-id')).toBeNull();
        });

        it('無い id は、404(何も作らない)', async () => {
            const result = await call('PUT', '/memos/nothing', {
                token: ALICE,
                json: { body: 'after' },
            });

            expect(result.status).toBe(404);
            expect(result.json).toEqual({ error: 'not_found' });
            expect(await store.find('nothing')).toBeNull();
        });

        it('別の人のメモは、403(何も変わらない)', async () => {
            await seed('bob', 'bob-original');

            const result = await call('PUT', '/memos/memo-1', {
                token: ALICE,
                json: { body: 'hacked' },
            });

            expect(result.status).toBe(403);
            expect(result.json).toEqual({ error: 'forbidden' });
            expect(await store.find('memo-1')).toMatchObject({
                owner: 'bob',
                body: 'bob-original',
            });
        });

        it.each([
            { name: '空文字', raw: '{"body":""}' },
            { name: 'body が無い', raw: '{}' },
            { name: 'JSON が壊れている', raw: '{bad' },
        ])(
            '入力が正しくなければ、400(何も変わらない): $name',
            async ({ raw }) => {
                await seed('alice', 'before');

                const result = await call('PUT', '/memos/memo-1', {
                    token: ALICE,
                    raw,
                });

                expect(result.status).toBe(400);
                expect((await store.find('memo-1'))?.body).toBe('before');
            },
        );

        it('入力の検証が先: 入力が正しくなければ、無い id でも、他人のメモでも、400', async () => {
            await seed('bob', 'bob-original');

            const unknown = await call('PUT', '/memos/nothing', {
                token: ALICE,
                json: { body: '' },
            });
            const others = await call('PUT', '/memos/memo-1', {
                token: ALICE,
                json: { body: '' },
            });

            expect(unknown.status).toBe(400);
            expect(others.status).toBe(400);
        });

        it('探してから更新するまでの間に、消された時は、404', async () => {
            await seed('alice', 'before');
            const racing: MemoStore = {
                ...store,
                update: async () => null,
            };
            await server.close();
            server = await startServer(createTestApp(racing));

            const result = await call('PUT', '/memos/memo-1', {
                token: ALICE,
                json: { body: 'after' },
            });

            expect(result.status).toBe(404);
            expect(result.json).toEqual({ error: 'not_found' });
        });
    });

    describe('DELETE /memos/:id(削除)', () => {
        it('自分のメモを消して、204(本文なし)。もう、見つからない', async () => {
            await seed('alice', 'hello');

            const result = await call('DELETE', '/memos/memo-1', {
                token: ALICE,
            });

            expect(result.status).toBe(204);
            expect(result.text).toBe('');
            expect(await store.find('memo-1')).toBeNull();
            const get = await call('GET', '/memos/memo-1', { token: ALICE });
            expect(get.status).toBe(404);
        });

        it('もう一度消すと、404', async () => {
            await seed('alice', 'hello');
            await call('DELETE', '/memos/memo-1', { token: ALICE });

            const result = await call('DELETE', '/memos/memo-1', {
                token: ALICE,
            });

            expect(result.status).toBe(404);
        });

        it('無い id は、404', async () => {
            const result = await call('DELETE', '/memos/nothing', {
                token: ALICE,
            });

            expect(result.status).toBe(404);
            expect(result.json).toEqual({ error: 'not_found' });
        });

        it('別の人のメモは、403(消えない)', async () => {
            await seed('bob', 'bob-original');

            const result = await call('DELETE', '/memos/memo-1', {
                token: ALICE,
            });

            expect(result.status).toBe(403);
            expect(result.json).toEqual({ error: 'forbidden' });
            expect(await store.find('memo-1')).toMatchObject({
                body: 'bob-original',
            });
        });

        it('他のメモは、残る', async () => {
            await seed('alice', 'a1');
            await seed('alice', 'a2');

            await call('DELETE', '/memos/memo-1', { token: ALICE });

            const list = await call('GET', '/memos', { token: ALICE });
            expect(list.json).toEqual({
                memos: [expect.objectContaining({ id: 'memo-2', body: 'a2' })],
            });
        });
    });

    describe('2 人が、別々に使う', () => {
        it('お互いのメモは、見えない、書き換えられない、消せない', async () => {
            await call('POST', '/memos', {
                token: ALICE,
                json: { body: 'alice memo' },
            });
            await call('POST', '/memos', {
                token: BOB,
                json: { body: 'bob memo' },
            });

            const aliceList = await call('GET', '/memos', { token: ALICE });
            const bobList = await call('GET', '/memos', { token: BOB });
            const bobReadsAlice = await call('GET', '/memos/memo-1', {
                token: BOB,
            });
            const aliceWritesBob = await call('PUT', '/memos/memo-2', {
                token: ALICE,
                json: { body: 'x' },
            });
            const bobDeletesAlice = await call('DELETE', '/memos/memo-1', {
                token: BOB,
            });

            expect(aliceList.json).toEqual({
                memos: [expect.objectContaining({ body: 'alice memo' })],
            });
            expect(bobList.json).toEqual({
                memos: [expect.objectContaining({ body: 'bob memo' })],
            });
            expect([
                bobReadsAlice.status,
                aliceWritesBob.status,
                bobDeletesAlice.status,
            ]).toEqual([403, 403, 403]);
            expect((await store.find('memo-1'))?.body).toBe('alice memo');
            expect((await store.find('memo-2'))?.body).toBe('bob memo');
        });
    });

    describe('使えないメソッド: 405(RFC 9110 15.5.6: Allow が要る)', () => {
        it.each([
            {
                name: 'PATCH /memos/:id',
                method: 'PATCH',
                path: '/memos/memo-1',
                allow: 'GET, PUT, DELETE',
            },
            {
                name: 'POST /memos/:id',
                method: 'POST',
                path: '/memos/memo-1',
                allow: 'GET, PUT, DELETE',
            },
            {
                name: 'DELETE /memos',
                method: 'DELETE',
                path: '/memos',
                allow: 'GET, POST',
            },
            {
                name: 'PUT /memos',
                method: 'PUT',
                path: '/memos',
                allow: 'GET, POST',
            },
        ])('$name', async ({ method, path, allow }) => {
            await seed('alice', 'hello');

            const result = await call(method, path, {
                token: ALICE,
                json: { body: 'x' },
            });

            expect(result.status).toBe(405);
            expect(result.headers.get('allow')).toBe(allow);
            expect(result.json).toEqual({ error: 'method_not_allowed' });
            expect((await store.find('memo-1'))?.body).toBe('hello');
        });

        it('認証が先: トークンが無ければ、405 ではなく、401', async () => {
            const result = await call('PATCH', '/memos/memo-1');

            expect(result.status).toBe(401);
        });
    });

    describe('返事は、キャッシュさせない(Cache-Control: no-store)', () => {
        it.each([
            {
                name: '一覧(200)',
                run: () => call('GET', '/memos', { token: ALICE }),
            },
            {
                name: '1 件(200)',
                run: () => call('GET', '/memos/memo-1', { token: ALICE }),
            },
            {
                name: '作成(201)',
                run: () =>
                    call('POST', '/memos', {
                        token: ALICE,
                        json: { body: 'x' },
                    }),
            },
            {
                name: '更新(200)',
                run: () =>
                    call('PUT', '/memos/memo-1', {
                        token: ALICE,
                        json: { body: 'x' },
                    }),
            },
            {
                name: '入力が正しくない(400)',
                run: () =>
                    call('POST', '/memos', {
                        token: ALICE,
                        json: { body: '' },
                    }),
            },
            {
                name: '持ち主が違う(403)',
                run: () => call('GET', '/memos/memo-1', { token: BOB }),
            },
            {
                name: 'スコープが足りない(403)',
                run: () =>
                    call('DELETE', '/memos/memo-1', { token: ALICE_READ_ONLY }),
            },
            {
                name: '無い(404)',
                run: () => call('GET', '/memos/nothing', { token: ALICE }),
            },
            {
                name: '使えないメソッド(405)',
                run: () => call('PATCH', '/memos/memo-1', { token: ALICE }),
            },
            {
                name: '削除(204)',
                run: () => call('DELETE', '/memos/memo-1', { token: ALICE }),
            },
        ])('$name', async ({ run }) => {
            await seed('alice', 'hello');

            const result = await run();

            expect(result.headers.get('cache-control')).toBe('no-store');
        });
    });

    describe('ストアの失敗(想定してない例外)', () => {
        it.each([
            {
                name: '一覧',
                method: 'GET',
                path: '/memos',
                fail: 'listByOwner',
            },
            {
                name: '1 件',
                method: 'GET',
                path: '/memos/memo-1',
                fail: 'find',
            },
            { name: '作成', method: 'POST', path: '/memos', fail: 'create' },
            {
                name: '削除',
                method: 'DELETE',
                path: '/memos/memo-1',
                fail: 'find',
            },
        ] as const)(
            '$name: 500 で、中身は返事に出さない',
            async ({ method, path, fail }) => {
                const consoleError = vi
                    .spyOn(console, 'error')
                    .mockImplementation(() => {});
                const broken: MemoStore = {
                    ...store,
                    [fail]: async () => {
                        throw new Error('DB-DOWN-DETAIL');
                    },
                };
                await server.close();
                server = await startServer(createTestApp(broken));

                const result = await call(method, path, {
                    token: ALICE,
                    json: method === 'POST' ? { body: 'x' } : undefined,
                });

                expect(result.status).toBe(500);
                expect(result.json).toEqual({ error: 'server_error' });
                expect(result.text).not.toContain('DB-DOWN-DETAIL');
                expect(consoleError).toHaveBeenCalledTimes(1);
                consoleError.mockRestore();
            },
        );
    });
});
