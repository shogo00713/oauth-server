import { createSecretKey } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import type { Config } from './lib/config.js';
import { importVerifyKey } from './lib/verify-key.js';
import { createMemoryMemoStore } from './stores/memory-memo-store.js';
import type { MemoStore } from './stores/memo-store.js';
import { startServer, type TestServer } from './test-utils/http.js';
import {
    createTestKeyPair,
    signToken,
    TEST_AUDIENCE,
    TEST_ISSUER,
    TEST_NOW,
    type Parts,
} from './test-utils/tokens.js';

const keys = createTestKeyPair();
const attacker = createTestKeyPair();

const config: Config = {
    issuer: TEST_ISSUER,
    port: 4002,
    audience: TEST_AUDIENCE,
    verifyKeyPath: 'unused',
    dbPath: 'unused',
    clockToleranceSec: 0,
};

// テストの中の時計(秒)。トークンを発行した 10 秒後
const clock = { now: TEST_NOW + 10 };

let memoStore: MemoStore;
// 起動中のサーバー(無ければ undefined)
let server: TestServer | undefined;

const start = async (
    overrides: {
        config?: Partial<Config>;
        memoStore?: MemoStore;
        verifyKey?: Parameters<typeof createApp>[0]['verifyKey'];
    } = {},
) => {
    await server?.close();
    server = undefined;
    server = await startServer(
        createApp({
            config: { ...config, ...overrides.config },
            memoStore: overrides.memoStore ?? memoStore,
            verifyKey: overrides.verifyKey ?? keys.publicKey,
            now: () => clock.now,
        }),
    );
};

beforeEach(async () => {
    clock.now = TEST_NOW + 10;
    memoStore = createMemoryMemoStore();
    await start();
});

afterEach(async () => {
    await server?.close();
    server = undefined;
});

const baseUrl = () => {
    if (!server) throw new Error('サーバーが起動していません');
    return server.baseUrl;
};

const tokenFor = (claims: Parts = {}) =>
    signToken(keys.privateKey, { claims: { scope: 'write', ...claims } });

async function call(
    method: string,
    path: string,
    init: { token?: string; json?: unknown } = {},
) {
    const response = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
            ...(init.token === undefined
                ? {}
                : { Authorization: `Bearer ${init.token}` }),
            ...(init.json === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
        },
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
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

describe('APP RS 全体(createApp)', () => {
    describe('トークンで、メモを操作できる(作成、一覧、取得、更新、削除)', () => {
        it('最初から最後まで通る', async () => {
            const token = tokenFor({ sub: 'alice' });

            const created = await call('POST', '/memos', {
                token,
                json: { body: 'hello' },
            });
            const id = String(created.json?.['id']);
            const list = await call('GET', '/memos', { token });
            const got = await call('GET', `/memos/${id}`, { token });
            const updated = await call('PUT', `/memos/${id}`, {
                token,
                json: { body: 'changed' },
            });
            const removed = await call('DELETE', `/memos/${id}`, { token });
            const after = await call('GET', `/memos/${id}`, { token });

            expect(created.status).toBe(201);
            expect(created.headers.get('location')).toBe(`/memos/${id}`);
            expect(list.json).toEqual({
                memos: [expect.objectContaining({ id, body: 'hello' })],
            });
            expect(got.json).toMatchObject({ id, body: 'hello' });
            expect(updated.json).toMatchObject({ id, body: 'changed' });
            expect(removed.status).toBe(204);
            expect(after.status).toBe(404);
        });

        it('メモは、トークンの sub の物になる(2 人が、別々に使う)', async () => {
            const alice = tokenFor({ sub: 'alice' });
            const bob = tokenFor({ sub: 'bob' });

            const created = await call('POST', '/memos', {
                token: alice,
                json: { body: 'alice memo' },
            });
            const bobsList = await call('GET', '/memos', { token: bob });
            const bobReads = await call(
                'GET',
                `/memos/${String(created.json?.['id'])}`,
                { token: bob },
            );

            expect(bobsList.json).toEqual({ memos: [] });
            expect(bobReads.status).toBe(403);
        });

        it('渡したストアに、保存される', async () => {
            const created = await call('POST', '/memos', {
                token: tokenFor({ sub: 'alice' }),
                json: { body: 'hello' },
            });

            const stored = await memoStore.find(String(created.json?.['id']));
            expect(stored).toMatchObject({ owner: 'alice', body: 'hello' });
        });
    });

    describe('設定(config)が、トークンの確認に使われる', () => {
        it('realm は、audience と同じ(WWW-Authenticate に入る)', async () => {
            await start({ config: { audience: 'my-api' } });

            const result = await call('GET', '/memos');

            expect(result.status).toBe(401);
            expect(result.headers.get('www-authenticate')).toBe(
                'Bearer realm="my-api"',
            );
        });

        it('スコープが足りない時(403)の realm も、audience と同じ', async () => {
            await start({ config: { audience: 'my-api' } });

            const result = await call('POST', '/memos', {
                token: tokenFor({ aud: 'my-api', scope: 'read' }),
                json: { body: 'x' },
            });

            expect(result.status).toBe(403);
            expect(result.headers.get('www-authenticate')).toContain(
                'realm="my-api"',
            );
        });

        it('audience が違うトークンは、断る(設定の audience が、使われている)', async () => {
            await start({ config: { audience: 'my-api' } });

            const result = await call('GET', '/memos', { token: tokenFor() });

            expect(result.status).toBe(401);
        });

        it('設定の audience に合うトークンは、通る', async () => {
            await start({ config: { audience: 'my-api' } });

            const result = await call('GET', '/memos', {
                token: tokenFor({ aud: 'my-api' }),
            });

            expect(result.status).toBe(200);
        });

        it('issuer が違うトークンは、断る(設定の issuer が、使われている)', async () => {
            await start({ config: { issuer: 'https://other.example.com' } });

            const result = await call('GET', '/memos', { token: tokenFor() });

            expect(result.status).toBe(401);
        });

        it('時計のずれを許す設定(clockToleranceSec)が、使われている', async () => {
            const token = tokenFor({ exp: TEST_NOW + 100 });
            clock.now = TEST_NOW + 129;

            const strict = await call('GET', '/memos', { token });
            await start({ config: { clockToleranceSec: 30 } });
            const lenient = await call('GET', '/memos', { token });

            expect(strict.status).toBe(401);
            expect(lenient.status).toBe(200);
        });

        it('渡した時計(now)が、使われている(期限が来たら、断る)', async () => {
            const token = tokenFor({ exp: TEST_NOW + 100 });

            clock.now = TEST_NOW + 99;
            const before = await call('GET', '/memos', { token });
            clock.now = TEST_NOW + 100;
            const after = await call('GET', '/memos', { token });

            expect(before.status).toBe(200);
            expect(after.status).toBe(401);
        });
    });

    describe('AS の公開鍵', () => {
        it('別の鍵で署名されたトークンは、断る', async () => {
            const result = await call('GET', '/memos', {
                token: signToken(attacker.privateKey),
            });

            expect(result.status).toBe(401);
        });

        it('importVerifyKey で読んだ鍵(CryptoKey)でも、動く', async () => {
            await start({ verifyKey: await importVerifyKey(keys.publicPem) });

            const result = await call('GET', '/memos', { token: tokenFor() });

            expect(result.status).toBe(200);
        });
    });

    describe('返事の共通のヘッダー', () => {
        it.each([
            {
                name: '200(メモの一覧)',
                run: () => call('GET', '/memos', { token: tokenFor() }),
            },
            { name: '401(トークンが無い)', run: () => call('GET', '/memos') },
            {
                name: '403(スコープが足りない)',
                run: () =>
                    call('POST', '/memos', {
                        token: tokenFor({ scope: 'read' }),
                        json: { body: 'x' },
                    }),
            },
            {
                name: '404(ルートが無い)',
                run: () => call('GET', '/nothing-here'),
            },
        ])(
            'Cache-Control: no-store、X-Content-Type-Options: nosniff が付いて、X-Powered-By は無い: $name',
            async ({ run }) => {
                const result = await run();

                expect(result.headers.get('cache-control')).toBe('no-store');
                expect(result.headers.get('x-content-type-options')).toBe(
                    'nosniff',
                );
                expect(result.headers.has('x-powered-by')).toBe(false);
            },
        );
    });

    describe('エラーの返事', () => {
        it('ルートが無い道は、404 の JSON(トークンは、要らない)', async () => {
            const result = await call('GET', '/nothing-here');

            expect(result.status).toBe(404);
            expect(result.json).toEqual({ error: 'not_found' });
        });

        it('ルートの / も、404', async () => {
            const result = await call('GET', '/');

            expect(result.status).toBe(404);
        });

        it('JSON が壊れた本文は、400 の JSON(エラー処理が、つながっている)', async () => {
            const response = await fetch(`${baseUrl()}/memos`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${tokenFor()}`,
                    'Content-Type': 'application/json',
                },
                body: '{bad',
            });

            expect(response.status).toBe(400);
            expect(await response.json()).toEqual({ error: 'invalid_request' });
        });

        it('ストアが失敗しても、500 の JSON で、中身は返事に出さない', async () => {
            const consoleError = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {});
            await start({
                memoStore: {
                    ...memoStore,
                    listByOwner: async () => {
                        throw new Error('DB-DOWN-DETAIL');
                    },
                },
            });

            const result = await call('GET', '/memos', { token: tokenFor() });

            expect(result.status).toBe(500);
            expect(result.json).toEqual({ error: 'server_error' });
            expect(result.text).not.toContain('DB-DOWN-DETAIL');
            consoleError.mockRestore();
        });

        it('鍵の種類が違う設定の間違いは、401 ではなく、500', async () => {
            const consoleError = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {});
            await start({
                verifyKey: createSecretKey(Buffer.from('x'.repeat(32))),
            });

            const result = await call('GET', '/memos', { token: tokenFor() });

            expect(result.status).toBe(500);
            consoleError.mockRestore();
        });
    });
});
