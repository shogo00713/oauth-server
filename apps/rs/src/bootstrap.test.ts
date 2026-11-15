import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrap } from './bootstrap.js';
import { startServer } from './test-utils/http.js';
import {
    createTestKeyPair,
    signToken,
    TEST_AUDIENCE,
    TEST_ISSUER,
    type TestKeyPair,
} from './test-utils/tokens.js';

const KEY_PATH = '../../keys/as-public.pem';

const env = (
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
    ISSUER: TEST_ISSUER,
    PORT: '4002',
    VERIFY_KEY_PATH: KEY_PATH,
    DB_PATH: ':memory:',
    ...overrides,
});

let keys: TestKeyPair;
let tempDir: string;

beforeAll(() => {
    keys = createTestKeyPair();
    tempDir = mkdtempSync(join(tmpdir(), 'rs-bootstrap-test-'));
}, 30_000);

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

// 本物の今の時計で有効なトークン(bootstrap は、本物の時計を使う)
const validToken = (sub = 'alice') => {
    const now = Math.floor(Date.now() / 1000);
    return signToken(keys.privateKey, {
        claims: { sub, scope: 'write', iat: now, exp: now + 600 },
    });
};

describe('BOOTSTRAP RS の起動の組み立て', () => {
    describe('bootstrap', () => {
        describe('起動できる例', () => {
            it('環境変数と公開鍵から、動く app ができて、トークンでメモを作って読める(全部がつながってる)', async () => {
                const { app } = await bootstrap(env(), {
                    readFile: async () => keys.publicPem,
                });
                const server = await startServer(app);

                try {
                    const headers = {
                        Authorization: `Bearer ${validToken()}`,
                        'Content-Type': 'application/json',
                    };
                    const created = await fetch(`${server.baseUrl}/memos`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ body: 'hello' }),
                    });
                    const list = await fetch(`${server.baseUrl}/memos`, {
                        headers,
                    });

                    expect(created.status).toBe(201);
                    expect(await list.json()).toEqual({
                        memos: [expect.objectContaining({ body: 'hello' })],
                    });
                } finally {
                    await server.close();
                }
            });

            it('トークンが無ければ、401(app が、設定の audience を realm にしている)', async () => {
                const { app } = await bootstrap(
                    env({ AUDIENCE: TEST_AUDIENCE }),
                    { readFile: async () => keys.publicPem },
                );
                const server = await startServer(app);

                try {
                    const response = await fetch(`${server.baseUrl}/memos`);

                    expect(response.status).toBe(401);
                    expect(response.headers.get('www-authenticate')).toBe(
                        'Bearer realm="simple-memo"',
                    );
                } finally {
                    await server.close();
                }
            });

            it('別の鍵で署名したトークンは、断る(渡した公開鍵だけを、信用している)', async () => {
                const { app } = await bootstrap(env(), {
                    readFile: async () => keys.publicPem,
                });
                const server = await startServer(app);
                const other = createTestKeyPair();
                const now = Math.floor(Date.now() / 1000);

                try {
                    const response = await fetch(`${server.baseUrl}/memos`, {
                        headers: {
                            Authorization: `Bearer ${signToken(other.privateKey, { claims: { iat: now, exp: now + 600 } })}`,
                        },
                    });

                    expect(response.status).toBe(401);
                } finally {
                    await server.close();
                }
            });

            it('config は、環境変数から作った物が返る', async () => {
                const { config } = await bootstrap(env({ PORT: '4321' }), {
                    readFile: async () => keys.publicPem,
                });

                expect(config.port).toBe(4321);
                expect(config.issuer).toBe(TEST_ISSUER);
                expect(config.verifyKeyPath).toBe(KEY_PATH);
                expect(config.dbPath).toBe(':memory:');
            });

            it('公開鍵は、VERIFY_KEY_PATH の場所から、1 回だけ読む', async () => {
                const readFile = vi.fn(async () => keys.publicPem);

                await bootstrap(env(), { readFile });

                expect(readFile).toHaveBeenCalledTimes(1);
                expect(readFile).toHaveBeenCalledWith(KEY_PATH);
            });

            it('読み方を指定しなければ、本物のファイルを読む', async () => {
                const keyFile = join(tempDir, 'as-public.pem');
                writeFileSync(keyFile, keys.publicPem);

                await expect(
                    bootstrap(env({ VERIFY_KEY_PATH: keyFile })),
                ).resolves.toBeDefined();
            });

            it('DB_PATH が :memory: なら、起動のたびに、メモの入れ物は、新しくなる(共有しない)', async () => {
                const first = await bootstrap(env(), {
                    readFile: async () => keys.publicPem,
                });
                const second = await bootstrap(env(), {
                    readFile: async () => keys.publicPem,
                });
                const serverA = await startServer(first.app);
                const serverB = await startServer(second.app);

                try {
                    await fetch(`${serverA.baseUrl}/memos`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${validToken()}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ body: 'only in A' }),
                    });
                    const listB = await fetch(`${serverB.baseUrl}/memos`, {
                        headers: { Authorization: `Bearer ${validToken()}` },
                    });

                    expect(await listB.json()).toEqual({ memos: [] });
                } finally {
                    await serverA.close();
                    await serverB.close();
                }
            });
        });

        describe('起動できない例(reject)', () => {
            it('環境変数が不正なら、名前がメッセージに入る。鍵のファイルは、読みにいかない', async () => {
                const readFile = vi.fn(async () => keys.publicPem);

                await expect(
                    bootstrap(env({ ISSUER: 'not a url' }), { readFile }),
                ).rejects.toThrow(/ISSUER/);
                expect(readFile).not.toHaveBeenCalled();
            });

            it('VERIFY_KEY_PATH が無ければ、名前がメッセージに入る', async () => {
                const readFile = vi.fn(async () => keys.publicPem);

                await expect(
                    bootstrap(env({ VERIFY_KEY_PATH: undefined }), {
                        readFile,
                    }),
                ).rejects.toThrow(/VERIFY_KEY_PATH/);
                expect(readFile).not.toHaveBeenCalled();
            });

            it('DB_PATH が無ければ、名前がメッセージに入る。鍵のファイルは、読みにいかない', async () => {
                const readFile = vi.fn(async () => keys.publicPem);

                await expect(
                    bootstrap(env({ DB_PATH: undefined }), { readFile }),
                ).rejects.toThrow(/DB_PATH/);
                expect(readFile).not.toHaveBeenCalled();
            });

            it('DB のファイルを開けなければ、場所がメッセージに入る。元の例外は、cause に残る', async () => {
                // フォルダを指している
                const promise = bootstrap(env({ DB_PATH: tempDir }), {
                    readFile: async () => keys.publicPem,
                });

                await expect(promise).rejects.toThrow(tempDir);
                await expect(promise).rejects.toMatchObject({
                    cause: expect.any(Error),
                });
            });

            it('環境変数が不正なら、DB のファイルは、作らない', async () => {
                const dbPath = join(tempDir, 'not-created-1.db');

                await expect(
                    bootstrap(env({ ISSUER: 'not a url', DB_PATH: dbPath }), {
                        readFile: async () => keys.publicPem,
                    }),
                ).rejects.toThrow(/ISSUER/);

                expect(existsSync(dbPath)).toBe(false);
            });

            it('鍵が読めない、または不正なら、DB のファイルは、作らない', async () => {
                const missing = join(tempDir, 'not-created-2.db');
                const broken = join(tempDir, 'not-created-3.db');

                await expect(
                    bootstrap(env({ DB_PATH: missing }), {
                        readFile: async () => {
                            throw new Error('no such file');
                        },
                    }),
                ).rejects.toThrow();
                await expect(
                    bootstrap(env({ DB_PATH: broken }), {
                        readFile: async () => 'not a pem',
                    }),
                ).rejects.toThrow();

                expect(existsSync(missing)).toBe(false);
                expect(existsSync(broken)).toBe(false);
            });

            it('鍵のファイルが無ければ、場所と gen:key の案内がメッセージに入る。元の例外は、cause に残る', async () => {
                const readFile = async (): Promise<string> => {
                    throw Object.assign(new Error('no such file'), {
                        code: 'ENOENT',
                    });
                };

                const promise = bootstrap(env(), { readFile });

                await expect(promise).rejects.toThrow(KEY_PATH);
                await expect(promise).rejects.toThrow('gen:key');
                await expect(promise).rejects.toMatchObject({
                    cause: { code: 'ENOENT' },
                });
            });

            it('鍵の中身が不正なら、場所がメッセージに入る', async () => {
                const promise = bootstrap(env(), {
                    readFile: async () => 'not a pem',
                });

                await expect(promise).rejects.toThrow(KEY_PATH);
                await expect(promise).rejects.toThrow('鍵');
            });

            it('秘密鍵を渡したら、断る(RS は、秘密鍵を持たない)。メッセージに、鍵の中身は入らない', async () => {
                const privatePem = keys.privateKey
                    .export({ type: 'pkcs8', format: 'pem' })
                    .toString();
                const body = privatePem.split('\n')[1] ?? '';

                const promise = bootstrap(env(), {
                    readFile: async () => privatePem,
                });

                await expect(promise).rejects.toThrow(KEY_PATH);
                await expect(promise).rejects.not.toThrow(body);
            });

            it('小さすぎる鍵(1024 bit)は、断る。元の例外は、cause に残る', async () => {
                const { publicKey } = generateKeyPairSync('rsa', {
                    modulusLength: 1024,
                });
                const small = publicKey
                    .export({ type: 'spki', format: 'pem' })
                    .toString();

                const promise = bootstrap(env(), {
                    readFile: async () => small,
                });

                await expect(promise).rejects.toThrow(KEY_PATH);
                await expect(promise).rejects.toMatchObject({
                    cause: expect.any(RangeError),
                });
            });
        });

        describe('データベース(SQLite)', () => {
            const readKey = async () => keys.publicPem;

            // メモを 1 つ作る(持ち主は、トークンの sub)
            const createMemo = async (
                baseUrl: string,
                body: string,
                sub = 'alice',
            ) => {
                const response = await fetch(`${baseUrl}/memos`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${validToken(sub)}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ body }),
                });
                return (await response.json()) as { id: string; body: string };
            };

            const listMemos = async (baseUrl: string, sub = 'alice') => {
                const response = await fetch(`${baseUrl}/memos`, {
                    headers: { Authorization: `Bearer ${validToken(sub)}` },
                });
                return (
                    (await response.json()) as {
                        memos: { id: string; body: string }[];
                    }
                ).memos;
            };

            it('止めて、もう一度起動しても、メモが残る(同じ id、同じ持ち主)', async () => {
                const dbPath = join(tempDir, 'restart.db');
                const first = await bootstrap(env({ DB_PATH: dbPath }), {
                    readFile: readKey,
                });
                const serverA = await startServer(first.app);
                const created = await createMemo(serverA.baseUrl, '牛乳を買う');
                await serverA.close();
                first.close();

                const second = await bootstrap(env({ DB_PATH: dbPath }), {
                    readFile: readKey,
                });
                const serverB = await startServer(second.app);

                try {
                    expect(await listMemos(serverB.baseUrl)).toEqual([
                        expect.objectContaining({
                            id: created.id,
                            body: '牛乳を買う',
                        }),
                    ]);
                    // 持ち主が違う人には、見えない
                    expect(await listMemos(serverB.baseUrl, 'bob')).toEqual([]);
                } finally {
                    await serverB.close();
                    second.close();
                }
            });

            it('止めて、もう一度起動したあとの、更新と削除も、残る', async () => {
                const dbPath = join(tempDir, 'restart-update.db');
                const first = await bootstrap(env({ DB_PATH: dbPath }), {
                    readFile: readKey,
                });
                const serverA = await startServer(first.app);
                const keep = await createMemo(serverA.baseUrl, 'keep');
                const drop = await createMemo(serverA.baseUrl, 'drop');
                await fetch(`${serverA.baseUrl}/memos/${keep.id}`, {
                    method: 'PUT',
                    headers: {
                        Authorization: `Bearer ${validToken()}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ body: 'kept and changed' }),
                });
                await fetch(`${serverA.baseUrl}/memos/${drop.id}`, {
                    method: 'DELETE',
                    headers: { Authorization: `Bearer ${validToken()}` },
                });
                await serverA.close();
                first.close();

                const second = await bootstrap(env({ DB_PATH: dbPath }), {
                    readFile: readKey,
                });
                const serverB = await startServer(second.app);

                try {
                    expect(
                        (await listMemos(serverB.baseUrl)).map((m) => m.body),
                    ).toEqual(['kept and changed']);
                } finally {
                    await serverB.close();
                    second.close();
                }
            });

            it('DB のファイルが、まだ無ければ、作る(置き場のフォルダが無くても)', async () => {
                const dbPath = join(tempDir, 'new-folder', 'deep', 'rs.db');

                const { close } = await bootstrap(env({ DB_PATH: dbPath }), {
                    readFile: readKey,
                });

                expect(existsSync(dbPath)).toBe(true);
                close();
            });

            it('DB_PATH が :memory: なら、ファイルを作らない', async () => {
                const { close } = await bootstrap(env(), {
                    readFile: readKey,
                });

                expect(existsSync(':memory:')).toBe(false);
                close();
            });

            it('close すると、データベースが閉じる(あとのリクエストは、500 のエラーになる。落ちない)', async () => {
                const { app, close } = await bootstrap(env(), {
                    readFile: readKey,
                });
                const server = await startServer(app);
                const consoleError = vi
                    .spyOn(console, 'error')
                    .mockImplementation(() => {});

                try {
                    close();
                    const response = await fetch(`${server.baseUrl}/memos`, {
                        headers: { Authorization: `Bearer ${validToken()}` },
                    });

                    expect(response.status).toBe(500);
                    // 比べるために、トークンが無い時は、DB を使わないので、これまで通り 401
                    expect(
                        (await fetch(`${server.baseUrl}/memos`)).status,
                    ).toBe(401);
                } finally {
                    consoleError.mockRestore();
                    await server.close();
                }
            });

            it('close は、2 回呼んでも、エラーにならない', async () => {
                const { close } = await bootstrap(env(), {
                    readFile: readKey,
                });

                close();

                expect(() => close()).not.toThrow();
            });
        });
    });
});
