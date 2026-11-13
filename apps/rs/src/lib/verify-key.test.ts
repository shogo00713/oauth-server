import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    createTestKeyPair,
    signToken,
    TEST_NOW,
    type TestKeyPair,
} from '../test-utils/tokens.js';
import { importVerifyKey } from './verify-key.js';

const spki = (key: { export: (o: object) => string | Buffer }) =>
    key.export({ type: 'spki', format: 'pem' }).toString();

let keys: TestKeyPair;

beforeAll(() => {
    keys = createTestKeyPair(2048);
}, 30_000);

describe('VERIFY-KEY AS の公開鍵の読み込み RFC 7518 3.3', () => {
    describe('importVerifyKey', () => {
        describe('読み込める例', () => {
            it('RSA 2048 bit の公開鍵(SPKI の PEM)が読める。署名を確かめる鍵になる', async () => {
                const key = await importVerifyKey(keys.publicPem);

                expect(key.type).toBe('public');
                expect(key.algorithm.name).toBe('RSASSA-PKCS1-v1_5');
                expect(key.usages).toEqual(['verify']);
            });

            it('読み込んだ鍵で、AS が署名したトークンを、確かめられる', async () => {
                const key = await importVerifyKey(keys.publicPem);
                const token = signToken(keys.privateKey);

                const { payload } = await jwtVerify(token, key, {
                    algorithms: ['RS256'],
                    currentDate: new Date((TEST_NOW + 10) * 1000),
                });

                expect(payload.sub).toBe('user-1');
            });

            it('2048 bit より大きい鍵(3072 bit)も、読める', async () => {
                const big = createTestKeyPair(3072);

                const key = await importVerifyKey(big.publicPem);

                expect(key.type).toBe('public');
            }, 30_000);

            it.each([
                {
                    name: '末尾の改行が無い',
                    transform: (pem: string) => pem.trimEnd(),
                },
                {
                    name: '末尾に空行が複数',
                    transform: (pem: string) => `${pem}\n\n`,
                },
                { name: '先頭に空行', transform: (pem: string) => `\n${pem}` },
                { name: '先頭に空白', transform: (pem: string) => `  ${pem}` },
                {
                    name: '改行が CRLF',
                    transform: (pem: string) => pem.replaceAll('\n', '\r\n'),
                },
            ])(
                '前後の空白や改行の違いがあっても、読める: $name',
                async ({ transform }) => {
                    const key = await importVerifyKey(
                        transform(keys.publicPem),
                    );

                    expect(key.type).toBe('public');
                },
            );
        });

        describe('鍵が小さすぎる(RS256 は 2048 bit 以上)', () => {
            it.each([1024, 2047])('%i bit は、RangeError', async (bits) => {
                const small = createTestKeyPair(bits);

                await expect(importVerifyKey(small.publicPem)).rejects.toThrow(
                    RangeError,
                );
            });
        });

        describe('鍵として使えない物は、エラー', () => {
            it('RSA ではない鍵(EC)', async () => {
                const { publicKey } = generateKeyPairSync('ec', {
                    namedCurve: 'P-256',
                });

                await expect(
                    importVerifyKey(spki(publicKey)),
                ).rejects.toThrow();
            });

            it('RSA ではない鍵(Ed25519)', async () => {
                const { publicKey } = generateKeyPairSync('ed25519');

                await expect(
                    importVerifyKey(spki(publicKey)),
                ).rejects.toThrow();
            });

            it('秘密鍵(RS は、秘密鍵を持たない)', async () => {
                const privatePem = keys.privateKey
                    .export({ type: 'pkcs8', format: 'pem' })
                    .toString();

                await expect(importVerifyKey(privatePem)).rejects.toThrow();
            });

            it('エラーのメッセージに、鍵の中身は入らない(ログに残っても、漏れない)', async () => {
                const privatePem = keys.privateKey
                    .export({ type: 'pkcs8', format: 'pem' })
                    .toString();
                const body = privatePem.split('\n')[1] ?? '';
                expect(body.length).toBeGreaterThan(20);

                const error = await importVerifyKey(privatePem).catch(
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(Error);
                expect((error as Error).message).not.toContain(body);
            });

            it('SPKI ではない形(PKCS#1 の公開鍵)', async () => {
                const pkcs1 = keys.publicKey
                    .export({ type: 'pkcs1', format: 'pem' })
                    .toString();

                await expect(importVerifyKey(pkcs1)).rejects.toThrow();
            });

            it.each([
                { name: '空文字', value: '' },
                { name: '空白だけ', value: '  \n ' },
                { name: 'PEM ではない文字列', value: 'not a pem' },
                {
                    name: '中身が壊れた PEM',
                    value: '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
                },
            ])('PEM ではない、または壊れている: $name', async ({ value }) => {
                await expect(importVerifyKey(value)).rejects.toThrow();
            });
        });
    });
});
