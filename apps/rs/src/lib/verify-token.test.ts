import { createSecretKey } from 'node:crypto';
import { importSPKI } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
    base64url,
    createTestKeyPair,
    defaultClaims,
    defaultHeader,
    hs256Token,
    signCompact,
    signToken,
    TEST_AUDIENCE,
    TEST_ISSUER,
    TEST_NOW,
    unsignedToken,
    type Parts,
    type TestKeyPair,
} from '../test-utils/tokens.js';
import {
    InvalidTokenError,
    verifyAccessToken,
    type InvalidTokenReason,
    type VerifyOptions,
} from './verify-token.js';

let keys: TestKeyPair;
let attacker: TestKeyPair;

beforeAll(() => {
    keys = createTestKeyPair();
    attacker = createTestKeyPair();
}, 30_000);

// 検証の標準の設定(今は、トークンを発行した 10 秒後)
const options = (overrides: Partial<VerifyOptions> = {}): VerifyOptions => ({
    publicKey: keys.publicKey,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    now: TEST_NOW + 10,
    ...overrides,
});

const verify = (token: string, overrides: Partial<VerifyOptions> = {}) =>
    verifyAccessToken(token, options(overrides));

// 正しい鍵で署名した、トークン
const signed = (claims: Parts = {}, header: Parts = {}) =>
    signToken(keys.privateKey, { claims, header });

// InvalidTokenError で、理由が reason であること
async function expectInvalid(
    token: string,
    reason: InvalidTokenReason,
    overrides: Partial<VerifyOptions> = {},
) {
    const error = await verify(token, overrides).then(
        () => null,
        (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(InvalidTokenError);
    expect((error as InvalidTokenError).reason).toBe(reason);
}

describe('VERIFY-TOKEN アクセストークンの検証 RFC 9068 4 / RFC 8725 3', () => {
    describe('verifyAccessToken', () => {
        describe('正しいトークン', () => {
            it('sub、client_id、scope が取り出せる', async () => {
                const token = signed({ scope: 'read write' });

                await expect(verify(token)).resolves.toEqual({
                    sub: 'user-1',
                    clientId: 'memoboard',
                    scope: ['read', 'write'],
                });
            });

            it('scope は、重複を消して、並び替えた配列になる', async () => {
                const token = signed({ scope: 'write read read' });

                const result = await verify(token);

                expect(result.scope).toEqual(['read', 'write']);
            });

            it('余計な claim があっても、通る', async () => {
                const token = signed({ foo: 'bar', roles: ['a', 'b'] });

                await expect(verify(token)).resolves.toMatchObject({
                    sub: 'user-1',
                });
            });

            it.each([
                'at+jwt',
                'application/at+jwt',
                'AT+JWT',
                'application/AT+JWT',
            ])('typ は %s でも通る(大文字小文字は区別しない)', async (typ) => {
                await expect(
                    verify(signed({}, { typ })),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });

            it('aud が配列でも、自分の名前が入っていれば、通る', async () => {
                const token = signed({ aud: ['other-api', TEST_AUDIENCE] });

                await expect(verify(token)).resolves.toMatchObject({
                    sub: 'user-1',
                });
            });

            it('kid が付いていても、見ない(今は、鍵が 1 つだけ)', async () => {
                const token = signed({}, { kid: 'some-other-kid' });

                await expect(verify(token)).resolves.toMatchObject({
                    sub: 'user-1',
                });
            });

            it('jku が付いていても、使わない(署名が正しければ、通る)', async () => {
                const token = signed(
                    {},
                    { jku: 'http://evil.example/jwks.json' },
                );

                await expect(verify(token)).resolves.toMatchObject({
                    sub: 'user-1',
                });
            });

            it('CryptoKey の公開鍵でも、確かめられる', async () => {
                const cryptoKey = await importSPKI(keys.publicPem, 'RS256');

                await expect(
                    verify(signed(), { publicKey: cryptoKey }),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });

            it('exp が小数でも、通る', async () => {
                const token = signed({ exp: TEST_NOW + 600.5 });

                await expect(verify(token)).resolves.toMatchObject({
                    sub: 'user-1',
                });
            });
        });

        describe('exp(RFC 9068 4: 今が exp より前でなければ、断る)', () => {
            const EXP = TEST_NOW + 100;

            it('exp の 1 秒前は、通る', async () => {
                await expect(
                    verify(signed({ exp: EXP }), { now: EXP - 1 }),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });

            it('ちょうど exp の時刻は、期限切れ', async () => {
                await expectInvalid(signed({ exp: EXP }), 'expired', {
                    now: EXP,
                });
            });

            it('exp を過ぎたら、期限切れ', async () => {
                await expectInvalid(signed({ exp: EXP }), 'expired', {
                    now: EXP + 1,
                });
            });

            it('時計のずれを許す設定が無ければ、1 秒でも過ぎたら、期限切れ(既定は 0 秒)', async () => {
                await expectInvalid(signed({ exp: EXP }), 'expired', {
                    now: EXP + 1,
                    clockToleranceSec: undefined,
                });
            });

            it('時計のずれを 30 秒まで許す設定なら、29 秒過ぎまでは通る', async () => {
                await expect(
                    verify(signed({ exp: EXP }), {
                        now: EXP + 29,
                        clockToleranceSec: 30,
                    }),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });

            it('時計のずれを 30 秒まで許す設定でも、30 秒過ぎたら、期限切れ', async () => {
                await expectInvalid(signed({ exp: EXP }), 'expired', {
                    now: EXP + 30,
                    clockToleranceSec: 30,
                });
            });

            it('now を渡さなければ、本物の時計を使う(今から 10 分有効なトークンは、通る)', async () => {
                const realNow = Math.floor(Date.now() / 1000);
                const token = signed({ iat: realNow, exp: realNow + 600 });

                await expect(
                    verify(token, { now: undefined }),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });

            it('now を渡さなければ、本物の時計を使う(1 秒前に切れたトークンは、断る)', async () => {
                const realNow = Math.floor(Date.now() / 1000);
                const token = signed({ iat: realNow - 600, exp: realNow - 1 });

                await expectInvalid(token, 'expired', { now: undefined });
            });
        });

        describe('nbf(あれば、その時刻より前は、断る)', () => {
            const NBF = TEST_NOW + 100;

            it('nbf の時刻ちょうどは、通る', async () => {
                await expect(
                    verify(signed({ nbf: NBF }), { now: NBF }),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });

            it('nbf より前は、まだ使えない', async () => {
                await expectInvalid(signed({ nbf: NBF }), 'not_yet_valid', {
                    now: NBF - 1,
                });
            });

            it('時計のずれを許す設定なら、その範囲では通る', async () => {
                await expect(
                    verify(signed({ nbf: NBF }), {
                        now: NBF - 30,
                        clockToleranceSec: 30,
                    }),
                ).resolves.toMatchObject({ sub: 'user-1' });
            });
        });

        describe('署名と alg(RFC 9068 4、RFC 8725 3.1)', () => {
            it('別の鍵で署名したトークンは、bad_signature', async () => {
                const token = signToken(attacker.privateKey);

                await expectInvalid(token, 'bad_signature');
            });

            it('payload を書き換えたら、bad_signature(署名は元のまま)', async () => {
                const [header = '', , signature = ''] = signed().split('.');
                const forged = `${header}.${base64url({ ...defaultClaims(), sub: 'admin' })}.${signature}`;

                await expectInvalid(forged, 'bad_signature');
            });

            it('header を書き換えたら、bad_signature(署名は元のまま)', async () => {
                const [, payload = '', signature = ''] = signed().split('.');
                const forged = `${base64url({ ...defaultHeader(), kid: 'x' })}.${payload}.${signature}`;

                await expectInvalid(forged, 'bad_signature');
            });

            it('署名を削ったら、bad_signature', async () => {
                const [header = '', payload = '', signature = ''] =
                    signed().split('.');

                await expectInvalid(
                    `${header}.${payload}.${signature.slice(0, 50)}`,
                    'bad_signature',
                );
            });

            it('署名が空なら、bad_signature(alg が RS256 のまま)', async () => {
                const [header = '', payload = ''] = signed().split('.');

                await expectInvalid(`${header}.${payload}.`, 'bad_signature');
            });

            it('署名が正しくなければ、期限切れでも、bad_signature(署名を確かめる前に、claim は信用しない)', async () => {
                const token = signToken(attacker.privateKey, {
                    claims: { exp: 1 },
                });

                await expectInvalid(token, 'bad_signature');
            });

            it('署名が正しくなければ、typ が違っても、bad_signature', async () => {
                const token = signToken(attacker.privateKey, {
                    header: { typ: 'JWT' },
                });

                await expectInvalid(token, 'bad_signature');
            });

            it('header に、攻撃者の公開鍵(jwk)を埋め込んで、その秘密鍵で署名しても、bad_signature', async () => {
                const jwk = attacker.publicKey.export({ format: 'jwk' });
                const token = signToken(attacker.privateKey, {
                    header: { jwk },
                });

                await expectInvalid(token, 'bad_signature');
            });

            it.each(['none', 'None', 'NONE'])(
                'alg が %s(署名なし)のトークンは、bad_algorithm',
                async (alg) => {
                    await expectInvalid(
                        unsignedToken({ header: { alg } }),
                        'bad_algorithm',
                    );
                },
            );

            it('alg が none で、署名に何か入っていても、bad_algorithm', async () => {
                const [, , signature = ''] = signed().split('.');

                await expectInvalid(
                    unsignedToken({ header: { alg: 'none' } }, signature),
                    'bad_algorithm',
                );
            });

            it('HS256 で、公開鍵の PEM を「秘密」にして署名したトークンは、bad_algorithm(取り違え攻撃)', async () => {
                await expectInvalid(
                    hs256Token(keys.publicPem),
                    'bad_algorithm',
                );
            });

            it.each([
                { name: 'RS384(正しい鍵で署名)', alg: 'RS384' },
                { name: 'PS256(正しい鍵で署名)', alg: 'PS256' },
            ])('RS256 以外の alg は、bad_algorithm: $name', async ({ alg }) => {
                await expectInvalid(signed({}, { alg }), 'bad_algorithm');
            });

            it('alg が ES256 と名乗るトークンは、bad_algorithm', async () => {
                await expectInvalid(
                    signed({}, { alg: 'ES256' }),
                    'bad_algorithm',
                );
            });

            it.each([
                { name: 'alg が無い', alg: undefined },
                { name: 'alg が数値', alg: 5 },
            ])('alg が読めない: $name は、malformed', async ({ alg }) => {
                await expectInvalid(signed({}, { alg }), 'malformed');
            });

            it('知らない拡張が crit に入っていたら、malformed', async () => {
                await expectInvalid(
                    signed({}, { crit: ['x-ext'], 'x-ext': 1 }),
                    'malformed',
                );
            });

            it('crit が空の配列でも、malformed', async () => {
                await expectInvalid(signed({}, { crit: [] }), 'malformed');
            });
        });

        describe('typ(RFC 9068 4: at+jwt だけ。ID トークンなどを、取り違えない)', () => {
            it.each([
                { name: 'JWT', typ: 'JWT' },
                { name: 'application/jwt', typ: 'application/jwt' },
                { name: '後ろに何か付いている', typ: 'at+jwt+' },
                { name: '前に何か付いている', typ: 'x-at+jwt' },
                { name: '空文字', typ: '' },
                { name: '数値', typ: 5 },
            ])('typ が $name: bad_type', async ({ typ }) => {
                await expectInvalid(signed({}, { typ }), 'bad_type');
            });

            it('typ が無い: bad_type', async () => {
                await expectInvalid(signed({}, { typ: undefined }), 'bad_type');
            });

            it('ID トークンのような物(typ が JWT で、nonce 付き)は、bad_type', async () => {
                const token = signed({ nonce: 'abc' }, { typ: 'JWT' });

                await expectInvalid(token, 'bad_type');
            });
        });

        describe('iss(RFC 9068 4: 期待する発行者と、完全に同じ)', () => {
            it.each([
                { name: '別の発行者', iss: 'http://evil.example' },
                { name: '末尾に /', iss: `${TEST_ISSUER}/` },
                { name: '大文字小文字が違う', iss: 'HTTP://LOCALHOST:4000' },
                { name: '後ろに文字が付いている', iss: `${TEST_ISSUER}x` },
                { name: '配列', iss: [TEST_ISSUER] },
                { name: '数値', iss: 4000 },
            ])('$name: bad_issuer', async ({ iss }) => {
                await expectInvalid(signed({ iss }), 'bad_issuer');
            });

            it('iss が無い: bad_issuer', async () => {
                await expectInvalid(signed({ iss: undefined }), 'bad_issuer');
            });
        });

        describe('aud(RFC 9068 4: 自分宛てでなければ、断る)', () => {
            it.each([
                { name: '別の API 宛て', aud: 'other-api' },
                { name: '後ろに文字が付いている', aud: `${TEST_AUDIENCE}-2` },
                { name: '大文字小文字が違う', aud: 'Simple-Memo' },
                { name: '配列に、自分の名前が無い', aud: ['a', 'b'] },
                { name: '空の配列', aud: [] },
                { name: '数値', aud: 1 },
            ])('$name: bad_audience', async ({ aud }) => {
                await expectInvalid(signed({ aud }), 'bad_audience');
            });

            it('aud が無い: bad_audience', async () => {
                await expectInvalid(signed({ aud: undefined }), 'bad_audience');
            });

            it('期待する aud を変えると、それ以外は断る', async () => {
                await expectInvalid(signed(), 'bad_audience', {
                    audience: 'other-api',
                });
            });
        });

        describe('必須の claim(この RS は、sub、client_id、scope、exp を要求する)', () => {
            it.each([
                { name: 'sub が無い', claims: { sub: undefined } },
                { name: 'sub が空文字', claims: { sub: '' } },
                { name: 'sub が数値', claims: { sub: 123 } },
                { name: 'sub が null', claims: { sub: null } },
                { name: 'client_id が無い', claims: { client_id: undefined } },
                { name: 'client_id が空文字', claims: { client_id: '' } },
                { name: 'client_id が数値', claims: { client_id: 1 } },
                { name: 'scope が無い', claims: { scope: undefined } },
                { name: 'scope が空文字', claims: { scope: '' } },
                { name: 'scope の先頭に空白', claims: { scope: ' read' } },
                {
                    name: 'scope の間に空白が 2 つ',
                    claims: { scope: 'read  write' },
                },
                { name: 'scope に " が入っている', claims: { scope: 're"ad' } },
                { name: 'scope が配列', claims: { scope: ['read'] } },
                { name: 'scope が数値', claims: { scope: 1 } },
                { name: 'scope が null', claims: { scope: null } },
                { name: 'exp が無い', claims: { exp: undefined } },
                { name: 'exp が文字列', claims: { exp: '9999999999' } },
                { name: 'exp が null', claims: { exp: null } },
                { name: 'iat が文字列', claims: { iat: 'yesterday' } },
            ])('$name: bad_claims', async ({ claims }) => {
                await expectInvalid(signed(claims), 'bad_claims');
            });

            it('iat と jti が無くても、通る(この RS は、使わない)', async () => {
                const token = signed({ iat: undefined, jti: undefined });

                await expect(verify(token)).resolves.toMatchObject({
                    sub: 'user-1',
                });
            });
        });

        describe('JWT の形(malformed)', () => {
            it.each([
                { name: '空文字', token: '' },
                { name: 'ドットが無い', token: 'abc' },
                { name: '2 つに分かれている', token: 'a.b' },
                { name: '4 つに分かれている', token: 'a.b.c.d' },
                { name: '5 つ(暗号化された JWT の形)', token: 'a.b.c.d.e' },
                { name: '3 つだけど、中身が出鱈目', token: 'a.b.c' },
                { name: 'header が base64url ではない', token: '!!!.e30.e30' },
                {
                    name: 'header が JSON ではない',
                    token: `${base64url('notjson')}.e30.e30`,
                },
                {
                    name: 'header が JSON の配列',
                    token: `${base64url('[]')}.e30.e30`,
                },
            ])('$name: malformed', async ({ token }) => {
                await expectInvalid(token, 'malformed');
            });

            it('署名が base64url ではない: malformed', async () => {
                const [header = '', payload = ''] = signed().split('.');

                await expectInvalid(`${header}.${payload}.!!!`, 'malformed');
            });

            it('署名の後ろに = が付いている: malformed', async () => {
                await expectInvalid(`${signed()}=`, 'malformed');
            });

            it.each([
                { name: 'JSON ではない', payload: 'notjson' },
                { name: 'JSON の配列', payload: '[]' },
                { name: 'JSON の null', payload: 'null' },
                { name: 'JSON の文字列', payload: '"text"' },
            ])(
                'payload が $name(署名は正しい): malformed',
                async ({ payload }) => {
                    const token = signCompact(
                        keys.privateKey,
                        defaultHeader(),
                        payload,
                    );

                    await expectInvalid(token, 'malformed');
                },
            );

            it('前に空白が付いたトークンは、通らない', async () => {
                const error = await verify(` ${signed()}`).then(
                    () => null,
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(InvalidTokenError);
            });
        });

        describe('設定の間違いは、トークンのせいにしない', () => {
            it('issuer が空文字なら、RangeError(何でも通す設定に、しない)', async () => {
                await expect(
                    verify(signed({ iss: '' }), { issuer: '' }),
                ).rejects.toThrow(RangeError);
            });

            it('audience が空文字なら、RangeError', async () => {
                await expect(
                    verify(signed({ aud: '' }), { audience: '' }),
                ).rejects.toThrow(RangeError);
            });

            it('鍵の種類が違う(共通鍵)のは、InvalidTokenError にしない(トークンの問題ではない)', async () => {
                const secret = createSecretKey(Buffer.from('x'.repeat(32)));

                const error = await verify(signed(), {
                    publicKey: secret,
                }).then(
                    () => null,
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(Error);
                expect(error).not.toBeInstanceOf(InvalidTokenError);
            });
        });

        describe('エラーの形', () => {
            it('InvalidTokenError は Error で、name と reason を持つ', async () => {
                const error = await verify('abc').then(
                    () => null,
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(Error);
                expect(error).toBeInstanceOf(InvalidTokenError);
                expect((error as InvalidTokenError).name).toBe(
                    'InvalidTokenError',
                );
                expect((error as InvalidTokenError).reason).toBe('malformed');
            });

            it('エラーのメッセージに、トークンは入らない(ログに残っても、漏れない)', async () => {
                const token = signed({ exp: TEST_NOW + 1 });
                const [, payload = ''] = token.split('.');

                const error = await verify(token).then(
                    () => null,
                    (e: unknown) => e,
                );

                expect(error).toBeInstanceOf(InvalidTokenError);
                expect((error as Error).message).not.toContain(token);
                expect((error as Error).message).not.toContain(payload);
            });

            it('InvalidTokenError を、自分で作れる(ミドルウェアのテストなどで使う)', () => {
                const error = new InvalidTokenError('expired');

                expect(error.reason).toBe('expired');
                expect(error).toBeInstanceOf(Error);
            });
        });
    });
});
