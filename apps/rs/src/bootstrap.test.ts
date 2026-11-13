import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

            it('起動のたびに、メモの入れ物は、新しくなる(共有しない)', async () => {
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
    });
});
