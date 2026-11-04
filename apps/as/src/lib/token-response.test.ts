import { describe, it, expect } from 'vitest';
import { buildTokenError, buildTokenSuccess } from './token-response.js';

const NO_CACHE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };
const BASIC_CHALLENGE = 'Basic realm="oauth-as"';

const successInput = () => ({
    accessToken: 'aaa.bbb.ccc',
    expiresIn: 600,
    scope: ['read', 'write'],
});

describe('TOKEN RESPONSE RFC 6749 5.1 / 5.2', () => {
    describe('buildTokenSuccess', () => {
        describe('成功の返事', () => {
            it('ステータスは 200', () => {
                expect(buildTokenSuccess(successInput()).status).toBe(200);
            });

            it('ボディは、access_token、token_type、expires_in、scope の 4 つだけ', () => {
                expect(buildTokenSuccess(successInput()).body).toEqual({
                    access_token: 'aaa.bbb.ccc',
                    token_type: 'Bearer',
                    expires_in: 600,
                    scope: 'read write',
                });
            });

            it('ヘッダーは、no-store と no-cache の 2 つだけ(RFC 6749 5.1 の MUST)', () => {
                expect(buildTokenSuccess(successInput()).headers).toEqual(
                    NO_CACHE,
                );
            });

            it('scope が 1 つでも、文字列で返る', () => {
                const res = buildTokenSuccess({
                    ...successInput(),
                    scope: ['read'],
                });
                expect(res.body['scope']).toBe('read');
            });

            it.each([1, 600, 3600])(
                'expires_in は、渡した秒数のまま: %s',
                (expiresIn) => {
                    const res = buildTokenSuccess({
                        ...successInput(),
                        expiresIn,
                    });
                    expect(res.body['expires_in']).toBe(expiresIn);
                },
            );

            it('ヘッダーは、呼ぶたびに別のオブジェクト(書き換えても、次に影響しない)', () => {
                const first = buildTokenSuccess(successInput());
                first.headers['X-Test'] = 'changed';

                expect(buildTokenSuccess(successInput()).headers).toEqual(
                    NO_CACHE,
                );
            });
        });

        describe('RangeError になる場合', () => {
            it.each([
                { name: '0', value: 0 },
                { name: '負の数', value: -1 },
                { name: '小数', value: 1.5 },
                { name: 'NaN', value: NaN },
                { name: 'Infinity', value: Infinity },
            ])('expiresIn が 1 以上の整数じゃない: $name', ({ value }) => {
                expect(() =>
                    buildTokenSuccess({ ...successInput(), expiresIn: value }),
                ).toThrow(RangeError);
            });

            it('scope が空配列', () => {
                expect(() =>
                    buildTokenSuccess({ ...successInput(), scope: [] }),
                ).toThrow(RangeError);
            });
        });
    });

    describe('buildTokenError', () => {
        describe('ステータスとヘッダー', () => {
            it.each([
                'invalid_request',
                'invalid_grant',
                'unauthorized_client',
                'unsupported_grant_type',
                'invalid_scope',
            ] as const)('%s は、400 で、no-cache のヘッダーだけ', (error) => {
                const res = buildTokenError(error);

                expect(res.status).toBe(400);
                expect(res.headers).toEqual(NO_CACHE);
            });

            it('invalid_client は、401 で、WWW-Authenticate: Basic が付く', () => {
                const res = buildTokenError('invalid_client');

                expect(res.status).toBe(401);
                expect(res.headers).toEqual({
                    ...NO_CACHE,
                    'WWW-Authenticate': BASIC_CHALLENGE,
                });
            });

            it.each(['invalid_request', 'invalid_client'] as const)(
                'ヘッダーは、呼ぶたびに別のオブジェクト: %s',
                (error) => {
                    const first = buildTokenError(error);
                    first.headers['X-Test'] = 'changed';

                    expect(buildTokenError(error).headers).not.toHaveProperty(
                        'X-Test',
                    );
                },
            );
        });

        describe('ボディ', () => {
            it.each([
                'invalid_request',
                'invalid_client',
                'invalid_grant',
                'unauthorized_client',
                'unsupported_grant_type',
                'invalid_scope',
            ] as const)('error に、エラー名がそのまま入る: %s', (error) => {
                expect(buildTokenError(error).body['error']).toBe(error);
            });

            it('説明が無ければ、error だけ(error_description のキーも無い)', () => {
                const res = buildTokenError('invalid_request');

                expect(Object.keys(res.body)).toEqual(['error']);
            });

            it('説明があれば、error_description に入る', () => {
                const res = buildTokenError('invalid_grant', 'code expired');

                expect(res.body).toEqual({
                    error: 'invalid_grant',
                    error_description: 'code expired',
                });
            });

            it('invalid_client にも、説明を付けられる(401 と WWW-Authenticate は、そのまま)', () => {
                const res = buildTokenError('invalid_client', 'bad secret');

                expect(res.status).toBe(401);
                expect(res.headers['WWW-Authenticate']).toBe(BASIC_CHALLENGE);
                expect(res.body).toEqual({
                    error: 'invalid_client',
                    error_description: 'bad secret',
                });
            });
        });

        describe('error_description に使える文字(RFC 6749 5.2: %x20-21 / %x23-5B / %x5D-7E)', () => {
            it.each([
                {
                    name: '普通の英文',
                    value: 'The code_verifier is invalid: expected 43-128 characters (RFC 7636).',
                },
                { name: '! (0x21)', value: 'a!b' },
                { name: '# (0x23)', value: 'a#b' },
                { name: '[ (0x5B)', value: 'a[b' },
                { name: '] (0x5D)', value: 'a]b' },
                { name: '~ (0x7E)', value: 'a~b' },
                { name: '空白 (0x20)', value: 'a b' },
            ])('使える: $name', ({ value }) => {
                const res = buildTokenError('invalid_request', value);

                expect(res.body['error_description']).toBe(value);
            });

            it.each([
                { name: '空文字(1 文字以上が要る)', value: '' },
                { name: 'ダブルクォート (0x22)', value: 'a"b' },
                { name: 'バックスラッシュ (0x5C)', value: 'a\\b' },
                { name: 'タブ', value: 'a\tb' },
                { name: '改行', value: 'a\nb' },
                { name: '制御文字 (0x1F)', value: 'a\x1Fb' },
                { name: 'DEL (0x7F)', value: 'a\x7Fb' },
                { name: '日本語', value: '不正なリクエスト' },
            ])('使えない(RangeError): $name', ({ value }) => {
                expect(() => buildTokenError('invalid_request', value)).toThrow(
                    RangeError,
                );
            });
        });
    });
});
