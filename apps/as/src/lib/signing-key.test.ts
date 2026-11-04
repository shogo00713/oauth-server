import { beforeAll, describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, calculateJwkThumbprint, importSPKI, jwtVerify } from 'jose';
import { issueAccessToken } from './access-token.js';
import { importSigningKey } from './signing-key.js';

type Pems = { privatePem: string; publicPem: string };

const generateRsa = (
    modulusLength = 2048,
    privateType: 'pkcs8' | 'pkcs1' = 'pkcs8',
): Pems => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength,
        privateKeyEncoding: { type: privateType, format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return { privatePem: privateKey, publicPem: publicKey };
};

let pairA: Pems;
let pairB: Pems;

beforeAll(() => {
    pairA = generateRsa();
    pairB = generateRsa();
}, 30_000);

describe('SIGNING KEY RFC 7518 3.3 / RFC 7638', () => {
    describe('importSigningKey', () => {
        describe('読み込める例', () => {
            it('秘密鍵と公開鍵が、できる', async () => {
                const { privateKey, publicKey } = await importSigningKey(
                    pairA.privatePem,
                );

                expect(privateKey.type).toBe('private');
                expect(publicKey.type).toBe('public');
            });

            it('作った秘密鍵で署名して、公開鍵で検証できる', async () => {
                const { privateKey, publicKey } = await importSigningKey(
                    pairA.privatePem,
                );

                const token = await new SignJWT({})
                    .setProtectedHeader({ alg: 'RS256' })
                    .sign(privateKey);

                await expect(
                    jwtVerify(token, publicKey),
                ).resolves.toBeDefined();
            });

            it('RS が持つ公開鍵の PEM でも、検証できる', async () => {
                const { privateKey } = await importSigningKey(pairA.privatePem);
                const token = await new SignJWT({})
                    .setProtectedHeader({ alg: 'RS256' })
                    .sign(privateKey);

                const publicKeyOfRs = await importSPKI(
                    pairA.publicPem,
                    'RS256',
                );

                await expect(
                    jwtVerify(token, publicKeyOfRs),
                ).resolves.toBeDefined();
            });

            it('別の鍵の公開鍵では、検証できない', async () => {
                const { privateKey } = await importSigningKey(pairA.privatePem);
                const token = await new SignJWT({})
                    .setProtectedHeader({ alg: 'RS256' })
                    .sign(privateKey);

                const otherPublicKey = await importSPKI(
                    pairB.publicPem,
                    'RS256',
                );

                await expect(
                    jwtVerify(token, otherPublicKey),
                ).rejects.toMatchObject({
                    code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
                });
            });

            it('issueAccessToken と、つなげて使える(kid がヘッダーに入る)', async () => {
                const { privateKey, publicKey, kid } = await importSigningKey(
                    pairA.privatePem,
                );

                const token = await issueAccessToken({
                    privateKey,
                    kid,
                    issuer: 'http://localhost:4000',
                    audience: 'simple-memo',
                    subject: 'user-1',
                    clientId: 'client-1',
                    scope: ['read'],
                    ttlSec: 600,
                });

                const { protectedHeader } = await jwtVerify(token, publicKey, {
                    issuer: 'http://localhost:4000',
                    audience: 'simple-memo',
                    typ: 'at+jwt',
                });
                expect(protectedHeader.kid).toBe(kid);
            });
        });

        describe('kid(RFC 7638 JWK Thumbprint)', () => {
            it('kid は、公開鍵の JWK Thumbprint と同じ', async () => {
                const { kid } = await importSigningKey(pairA.privatePem);

                const publicKey = await importSPKI(pairA.publicPem, 'RS256');
                expect(kid).toBe(await calculateJwkThumbprint(publicKey));
            });

            it('同じ鍵なら、何度読んでも同じ kid', async () => {
                const first = await importSigningKey(pairA.privatePem);
                const second = await importSigningKey(pairA.privatePem);

                expect(second.kid).toBe(first.kid);
            });

            it('別の鍵なら、別の kid', async () => {
                const a = await importSigningKey(pairA.privatePem);
                const b = await importSigningKey(pairB.privatePem);

                expect(b.kid).not.toBe(a.kid);
            });
        });

        describe('読めない場合(reject)', () => {
            it.each([
                { name: '空文字', make: () => '' },
                { name: 'PEM じゃない文字列', make: () => 'not a pem' },
                {
                    name: '中身が壊れた PEM',
                    make: () =>
                        '-----BEGIN PRIVATE KEY------------------END PRIVATE KEY-----\n',
                },
                { name: '公開鍵の PEM', make: () => pairA.publicPem },
                {
                    name: 'PKCS#1 形式の秘密鍵(BEGIN RSA PRIVATE KEY)',
                    make: () => generateRsa(2048, 'pkcs1').privatePem,
                },
                {
                    name: 'RSA じゃない鍵(EC)',
                    make: () =>
                        generateKeyPairSync('ec', {
                            namedCurve: 'P-256',
                            privateKeyEncoding: {
                                type: 'pkcs8',
                                format: 'pem',
                            },
                            publicKeyEncoding: { type: 'spki', format: 'pem' },
                        }).privateKey,
                },
                {
                    name: '2048 bit 未満の RSA 鍵(1024 bit)',
                    make: () => generateRsa(1024).privatePem,
                },
            ])('読めない: $name', async ({ make }) => {
                await expect(importSigningKey(make())).rejects.toThrow();
            });
        });
    });
});
