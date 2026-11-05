import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jwtVerify } from 'jose';
import { bootstrap } from './bootstrap.js';
import { sha256Hex } from './lib/hash.js';
import { importSigningKey } from './lib/signing-key.js';

const SECRET = 'a'.repeat(40);
const KEY_PATH = '../../keys/as-private.pem';
const REDIRECT_URI = 'http://localhost:3000/callback';
const CODE = 'authorization-code-for-test';
// RFC 7636 付録 B の組
const CODE_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const env = (
    overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> => ({
    ISSUER: 'http://localhost:4000',
    PORT: '4000',
    SIGNING_KEY_PATH: KEY_PATH,
    CLIENT_SECRET: SECRET,
    CLIENT_REDIRECT_URIS: REDIRECT_URI,
    ...overrides,
});

let pem: string;
let tempDir: string;

beforeAll(() => {
    pem = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    }).privateKey;
    tempDir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'));
}, 30_000);

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('BOOTSTRAP 起動の組み立て', () => {
    describe('bootstrap', () => {
        describe('起動できる例', () => {
            it('環境変数と鍵から、動く app ができて、/token でトークンが取れる(全部がつながってる)', async () => {
                const { app, codeStore } = await bootstrap(env(), {
                    readFile: async () => pem,
                });
                await codeStore.save(sha256Hex(CODE), {
                    clientId: 'memoboard',
                    redirectUri: REDIRECT_URI,
                    codeChallenge: CODE_CHALLENGE,
                    sub: 'user-1',
                    scope: ['read'],
                    expiresAt: Math.floor(Date.now() / 1000) + 60,
                });
                const server = app.listen(0);
                await new Promise<void>((resolve) =>
                    server.once('listening', resolve),
                );
                const { port } = server.address() as AddressInfo;

                try {
                    const res = await fetch(`http://127.0.0.1:${port}/token`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Basic ${Buffer.from(`memoboard:${SECRET}`).toString('base64')}`,
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                        body: new URLSearchParams({
                            grant_type: 'authorization_code',
                            code: CODE,
                            redirect_uri: REDIRECT_URI,
                            code_verifier: CODE_VERIFIER,
                        }),
                    });
                    const json = (await res.json()) as { access_token: string };

                    expect(res.status).toBe(200);
                    const { publicKey, kid } = await importSigningKey(pem);
                    const { payload, protectedHeader } = await jwtVerify(
                        json.access_token,
                        publicKey,
                        {
                            issuer: 'http://localhost:4000',
                            audience: 'simple-memo',
                            typ: 'at+jwt',
                        },
                    );
                    expect(payload['client_id']).toBe('memoboard');
                    expect(protectedHeader.kid).toBe(kid);
                } finally {
                    server.closeAllConnections();
                    await new Promise((resolve) => server.close(resolve));
                }
            });

            it('config は、環境変数から作った物が返る', async () => {
                const { config } = await bootstrap(env({ PORT: '4321' }), {
                    readFile: async () => pem,
                });

                expect(config.port).toBe(4321);
                expect(config.issuer).toBe('http://localhost:4000');
            });

            it('鍵は、SIGNING_KEY_PATH の場所から、1 回だけ読む', async () => {
                const readFile = vi.fn(async () => pem);

                await bootstrap(env(), { readFile });

                expect(readFile).toHaveBeenCalledTimes(1);
                expect(readFile).toHaveBeenCalledWith(KEY_PATH);
            });

            it('読み方を指定しなければ、本物のファイルを読む', async () => {
                const keyFile = join(tempDir, 'as-private.pem');
                writeFileSync(keyFile, pem);

                await expect(
                    bootstrap(env({ SIGNING_KEY_PATH: keyFile })),
                ).resolves.toBeDefined();
            });
        });

        describe('起動できない例(reject)', () => {
            it('環境変数が不正なら、名前がメッセージに入る。鍵のファイルは、読みにいかない', async () => {
                const readFile = vi.fn(async () => pem);

                await expect(
                    bootstrap(env({ ISSUER: 'not a url' }), { readFile }),
                ).rejects.toThrow(/ISSUER/);
                expect(readFile).not.toHaveBeenCalled();
            });

            it('クライアントの設定が不正なら、名前がメッセージに入る。鍵のファイルは、読みにいかない', async () => {
                const readFile = vi.fn(async () => pem);

                await expect(
                    bootstrap(env({ CLIENT_SECRET: undefined }), { readFile }),
                ).rejects.toThrow(/CLIENT_SECRET/);
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
        });
    });
});
