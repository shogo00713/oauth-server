import { beforeAll, describe, it, expect } from 'vitest';
import {
    decodeJwt,
    decodeProtectedHeader,
    generateKeyPair,
    jwtVerify,
} from 'jose';
import { issueAccessToken } from './access-token.js';

const ISSUER = 'http://localhost:4000';
const AUDIENCE = 'simple-memo';
const NOW = 1_700_000_000;

type KeyPair = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: KeyPair;
let otherKeys: KeyPair;

beforeAll(async () => {
    keys = await generateKeyPair('RS256');
    otherKeys = await generateKeyPair('RS256');
}, 30_000);

const input = () => ({
    privateKey: keys.privateKey,
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: 'user-1',
    clientId: 'client-1',
    scope: ['read', 'write'],
    ttlSec: 600,
    now: NOW,
});

const at = (epochSec: number) => new Date(epochSec * 1000);

// RS が行う検証と、同じもの(署名、iss、aud、typ、期限)
const verify = (
    token: string,
    publicKey = keys.publicKey,
    currentDate = at(NOW + 10),
) =>
    jwtVerify(token, publicKey, {
        issuer: ISSUER,
        audience: AUDIENCE,
        typ: 'at+jwt',
        currentDate,
    });

describe('ACCESS TOKEN RFC 9068 2.1 / 2.2', () => {
    describe('issueAccessToken', () => {
        describe('発行できる例', () => {
            it('RS が行う検証(署名、iss、aud、typ、期限)を、全部通る', async () => {
                const token = await issueAccessToken(input());

                const { payload } = await verify(token);
                expect(payload.sub).toBe('user-1');
            });

            it('ヘッダーは、alg: RS256 と typ: at+jwt だけ(kid を渡さない時)', async () => {
                const token = await issueAccessToken(input());

                expect(decodeProtectedHeader(token)).toEqual({
                    alg: 'RS256',
                    typ: 'at+jwt',
                });
            });

            it('kid を渡すと、ヘッダーに入る', async () => {
                const token = await issueAccessToken({
                    ...input(),
                    kid: 'key-1',
                });

                expect(decodeProtectedHeader(token)).toEqual({
                    alg: 'RS256',
                    typ: 'at+jwt',
                    kid: 'key-1',
                });
            });

            it('クレームは、RFC 9068 2.2 の 7 つ(iss、exp、aud、sub、client_id、iat、jti)と scope だけ', async () => {
                const token = await issueAccessToken(input());

                expect(decodeJwt(token)).toEqual({
                    iss: ISSUER,
                    sub: 'user-1',
                    aud: AUDIENCE,
                    client_id: 'client-1',
                    scope: 'read write',
                    iat: NOW,
                    exp: NOW + 600,
                    jti: expect.any(String),
                });
            });

            it('scope が 1 つでも、文字列', async () => {
                const token = await issueAccessToken({
                    ...input(),
                    scope: ['read'],
                });

                expect(decodeJwt(token)['scope']).toBe('read');
            });

            it.each([1, 600, 3600])(
                'exp は、iat + ttlSec: %s',
                async (ttlSec) => {
                    const token = await issueAccessToken({
                        ...input(),
                        ttlSec,
                    });

                    const { iat, exp } = decodeJwt(token);
                    expect(iat).toBe(NOW);
                    expect(exp).toBe(NOW + ttlSec);
                },
            );

            it('now を渡さなければ、今の時刻(秒)が iat になる', async () => {
                const before = Math.floor(Date.now() / 1000);
                const token = await issueAccessToken({
                    ...input(),
                    now: undefined,
                });
                const after = Math.floor(Date.now() / 1000);

                const { iat, exp } = decodeJwt(token);
                expect(iat).toBeGreaterThanOrEqual(before);
                expect(iat).toBeLessThanOrEqual(after);
                expect(exp).toBe((iat ?? NaN) + 600);
            });

            it('ttlSec 秒の間だけ有効(exp ちょうどは、もう期限切れ)', async () => {
                const token = await issueAccessToken(input());

                await expect(
                    verify(token, keys.publicKey, at(NOW + 599)),
                ).resolves.toBeDefined();
                await expect(
                    verify(token, keys.publicKey, at(NOW + 600)),
                ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
            });
        });

        describe('jti と署名', () => {
            it('jti は、呼ぶたびに別の値(同じ入力でも、別のトークン)', async () => {
                const [a, b] = await Promise.all([
                    issueAccessToken(input()),
                    issueAccessToken(input()),
                ]);

                expect(decodeJwt(a).jti).not.toBe(decodeJwt(b).jti);
                expect(a).not.toBe(b);
            });

            it('jti は、空じゃない文字列', async () => {
                const token = await issueAccessToken(input());

                expect(decodeJwt(token).jti?.length).toBeGreaterThan(0);
            });

            it('別の鍵では、検証が通らない', async () => {
                const token = await issueAccessToken(input());

                await expect(
                    verify(token, otherKeys.publicKey),
                ).rejects.toMatchObject({
                    code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
                });
            });
        });

        describe('RangeError になる場合', () => {
            it.each([
                { name: '0', value: 0 },
                { name: '負の数', value: -1 },
                { name: '小数', value: 1.5 },
                { name: 'NaN', value: NaN },
                { name: 'Infinity', value: Infinity },
            ])('ttlSec が 1 以上の整数じゃない: $name', async ({ value }) => {
                await expect(
                    issueAccessToken({ ...input(), ttlSec: value }),
                ).rejects.toThrow(RangeError);
            });

            it('scope が空配列', async () => {
                await expect(
                    issueAccessToken({ ...input(), scope: [] }),
                ).rejects.toThrow(RangeError);
            });

            it.each(['issuer', 'audience', 'subject', 'clientId'] as const)(
                '%s が空文字',
                async (field) => {
                    await expect(
                        issueAccessToken({ ...input(), [field]: '' }),
                    ).rejects.toThrow(RangeError);
                },
            );
        });
    });
});
