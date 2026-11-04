import { describe, it, expect } from 'vitest';
import { parseTokenRequest } from './token-request.js';

const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

const validBody = {
    grant_type: 'authorization_code',
    code: 'abc',
    redirect_uri: 'http://a.example/cb',
    code_verifier: verifier,
};

const invalidRequest = { ok: false, error: 'invalid_request' };
const unsupportedGrantType = { ok: false, error: 'unsupported_grant_type' };

describe('TOKEN REQUEST RFC 6749 4.1.3 / RFC 7636 4.5', () => {
    describe('parseTokenRequest', () => {
        describe('成功する例', () => {
            it('必須のパラメータが揃っていれば、取り出して返す', () => {
                expect(parseTokenRequest(validBody)).toEqual({
                    ok: true,
                    value: {
                        code: 'abc',
                        redirectUri: 'http://a.example/cb',
                        codeVerifier: verifier,
                        clientId: undefined,
                    },
                });
            });

            it('client_id が付いていれば、clientId として返す', () => {
                expect(
                    parseTokenRequest({ ...validBody, client_id: 'my-client' }),
                ).toEqual({
                    ok: true,
                    value: {
                        code: 'abc',
                        redirectUri: 'http://a.example/cb',
                        codeVerifier: verifier,
                        clientId: 'my-client',
                    },
                });
            });

            it('知らないパラメータは、無視する', () => {
                expect(
                    parseTokenRequest({ ...validBody, foo: 'bar', state: 'x' }),
                ).toEqual({
                    ok: true,
                    value: {
                        code: 'abc',
                        redirectUri: 'http://a.example/cb',
                        codeVerifier: verifier,
                        clientId: undefined,
                    },
                });
            });

            it('空の client_id と client_secret は、省略されたものとして扱う', () => {
                expect(
                    parseTokenRequest({
                        ...validBody,
                        client_id: '',
                        client_secret: '',
                    }),
                ).toEqual({
                    ok: true,
                    value: {
                        code: 'abc',
                        redirectUri: 'http://a.example/cb',
                        codeVerifier: verifier,
                        clientId: undefined,
                    },
                });
            });

            it('redirect_uri は、正規化せずに、そのまま返す', () => {
                const result = parseTokenRequest({
                    ...validBody,
                    redirect_uri: 'HTTP://A.EXAMPLE:80/cb/?x=1',
                });
                expect(result).toMatchObject({
                    ok: true,
                    value: { redirectUri: 'HTTP://A.EXAMPLE:80/cb/?x=1' },
                });
            });

            it.each([
                { name: '下限(43 文字)', codeVerifier: 'a'.repeat(43) },
                { name: '上限(128 文字)', codeVerifier: 'a'.repeat(128) },
            ])('code_verifier の長さ: $name', ({ codeVerifier }) => {
                expect(
                    parseTokenRequest({
                        ...validBody,
                        code_verifier: codeVerifier,
                    }),
                ).toMatchObject({ ok: true, value: { codeVerifier } });
            });

            it('プロトタイプのないオブジェクトでも、通る', () => {
                const body = Object.assign(Object.create(null), validBody);
                expect(parseTokenRequest(body)).toMatchObject({ ok: true });
            });
        });

        describe('invalid_request になる場合', () => {
            it.each([
                { name: 'null', body: null },
                { name: 'undefined', body: undefined },
                { name: '文字列', body: 'grant_type=authorization_code' },
                { name: '数値', body: 12 },
                { name: '配列', body: [validBody] },
            ])('ボディがオブジェクトではない: $name', ({ body }) => {
                expect(parseTokenRequest(body)).toEqual(invalidRequest);
            });

            it('ボディが空のオブジェクト', () => {
                expect(parseTokenRequest({})).toEqual(invalidRequest);
            });

            it.each(['grant_type', 'code', 'redirect_uri', 'code_verifier'])(
                '必須のパラメータがない: %s',
                (name) => {
                    const body: Record<string, string> = { ...validBody };
                    delete body[name];
                    expect(parseTokenRequest(body)).toEqual(invalidRequest);
                },
            );

            it.each(['grant_type', 'code', 'redirect_uri', 'code_verifier'])(
                '必須のパラメータが空文字(省略扱い): %s',
                (name) => {
                    expect(
                        parseTokenRequest({ ...validBody, [name]: '' }),
                    ).toEqual(invalidRequest);
                },
            );

            it.each([
                'grant_type',
                'code',
                'redirect_uri',
                'code_verifier',
                'client_id',
            ])('パラメータが繰り返されている: %s', (name) => {
                expect(
                    parseTokenRequest({ ...validBody, [name]: ['a', 'b'] }),
                ).toEqual(invalidRequest);
            });

            it.each([
                { name: '数値', value: 12 },
                { name: 'null', value: null },
                { name: 'オブジェクト', value: { a: 'b' } },
            ])('パラメータが文字列ではない: $name', ({ value }) => {
                expect(
                    parseTokenRequest({ ...validBody, code: value }),
                ).toEqual(invalidRequest);
            });

            it('ボディに client_secret が入っている(認証情報が複数になる)', () => {
                expect(
                    parseTokenRequest({ ...validBody, client_secret: 'x' }),
                ).toEqual(invalidRequest);
            });

            it.each([
                { name: '42 文字(短すぎる)', value: 'a'.repeat(42) },
                { name: '129 文字(長すぎる)', value: 'a'.repeat(129) },
                { name: '使えない文字(+)', value: `${'a'.repeat(42)}+` },
                { name: '日本語', value: `${'a'.repeat(42)}あ` },
            ])('code_verifier の形式が違う: $name', ({ value }) => {
                expect(
                    parseTokenRequest({ ...validBody, code_verifier: value }),
                ).toEqual(invalidRequest);
            });
        });

        describe('unsupported_grant_type になる場合', () => {
            it.each([
                'refresh_token',
                'password',
                'client_credentials',
                'Authorization_Code',
                'authorization_code ',
            ])('authorization_code 以外: %j', (grantType) => {
                expect(
                    parseTokenRequest({ ...validBody, grant_type: grantType }),
                ).toEqual(unsupportedGrantType);
            });

            it('他のパラメータが足りなくても、grant_type の判定が先', () => {
                expect(parseTokenRequest({ grant_type: 'password' })).toEqual(
                    unsupportedGrantType,
                );
            });
        });

        describe('エラーの優先順', () => {
            it('パラメータの繰り返しは、unsupported_grant_type より先', () => {
                expect(
                    parseTokenRequest({
                        grant_type: 'password',
                        code: ['a', 'b'],
                    }),
                ).toEqual(invalidRequest);
            });

            it('grant_type が違えば、client_secret があっても unsupported_grant_type', () => {
                expect(
                    parseTokenRequest({
                        ...validBody,
                        grant_type: 'password',
                        client_secret: 'x',
                    }),
                ).toEqual(unsupportedGrantType);
            });
        });
    });
});
