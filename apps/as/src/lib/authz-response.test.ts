import { describe, expect, it } from 'vitest';
import { buildAuthzErrorUrl, buildAuthzSuccessUrl } from './authz-response.js';

const REDIRECT_URI = 'http://localhost:4001/callback';
const REDIRECT_URI_WITH_QUERY = 'https://memoboard.example.com/cb?x=1';

// 結果の URL から、パラメータを読む
const paramsOf = (url: string) => new URL(url).searchParams;

describe('AUTHZ RESPONSE RFC 6749 3.1.2 / 4.1.2 / 4.1.2.1', () => {
    describe('buildAuthzSuccessUrl', () => {
        describe('作れる例', () => {
            it('redirect_uri の後ろに、code と state がつく(順番も、この通り)', () => {
                expect(
                    buildAuthzSuccessUrl(REDIRECT_URI, {
                        code: 'abc',
                        state: 'xyz',
                    }),
                ).toBe(`${REDIRECT_URI}?code=abc&state=xyz`);
            });

            it('state が無ければ、code だけ', () => {
                expect(
                    buildAuthzSuccessUrl(REDIRECT_URI, { code: 'abc' }),
                ).toBe(`${REDIRECT_URI}?code=abc`);
            });

            it.each([undefined, ''])(
                'state が %j なら、state はつかない',
                (state) => {
                    expect(
                        buildAuthzSuccessUrl(REDIRECT_URI, {
                            code: 'abc',
                            state,
                        }),
                    ).toBe(`${REDIRECT_URI}?code=abc`);
                },
            );

            it('元のクエリは、そのまま残して、後ろに足す(RFC 6749 3.1.2 の MUST)', () => {
                expect(
                    buildAuthzSuccessUrl(REDIRECT_URI_WITH_QUERY, {
                        code: 'abc',
                        state: 'xyz',
                    }),
                ).toBe(`${REDIRECT_URI_WITH_QUERY}&code=abc&state=xyz`);
            });

            it('元のクエリの書き方(%20 など)も、1 文字も変えない', () => {
                const uri = 'https://memoboard.example.com/cb?a=%20b&c=d+e';

                expect(
                    buildAuthzSuccessUrl(uri, { code: 'abc', state: 'xyz' }),
                ).toBe(`${uri}&code=abc&state=xyz`);
            });

            it.each([
                { name: '末尾が ?', uri: 'https://memoboard.example.com/cb?' },
                {
                    name: '末尾が &',
                    uri: 'https://memoboard.example.com/cb?x=1&',
                },
            ])('$name でも、区切りが重ならない', ({ uri }) => {
                expect(buildAuthzSuccessUrl(uri, { code: 'abc' })).toBe(
                    `${uri}code=abc`,
                );
            });

            it('state の記号や日本語は、エンコードされて、読み戻すと元に戻る', () => {
                const state = 'a b&c=d?é/あ%';

                const url = buildAuthzSuccessUrl(REDIRECT_URI, {
                    code: 'abc',
                    state,
                });

                expect(paramsOf(url).get('state')).toBe(state);
                expect(paramsOf(url).getAll('state')).toHaveLength(1);
                expect(paramsOf(url).get('code')).toBe('abc');
            });

            it('code の記号も、エンコードされて、読み戻すと元に戻る', () => {
                const url = buildAuthzSuccessUrl(REDIRECT_URI, {
                    code: 'a+b/c=d',
                });

                expect(paramsOf(url).get('code')).toBe('a+b/c=d');
            });

            it('戻り先の、場所(ホスト、パス)は、そのまま', () => {
                const url = new URL(
                    buildAuthzSuccessUrl(REDIRECT_URI, { code: 'abc' }),
                );

                expect(url.origin).toBe('http://localhost:4001');
                expect(url.pathname).toBe('/callback');
                expect(url.hash).toBe('');
            });
        });

        describe('RangeError になる場合', () => {
            it('code が空文字', () => {
                expect(() =>
                    buildAuthzSuccessUrl(REDIRECT_URI, { code: '' }),
                ).toThrow(RangeError);
            });

            it.each([
                {
                    name: 'code',
                    uri: 'https://x.example.com/cb?code=1',
                    state: 'xyz',
                },
                {
                    name: 'state',
                    uri: 'https://x.example.com/cb?state=1',
                    state: 'xyz',
                },
            ])(
                '元のクエリに、足すパラメータと同じ名前がある: $name(同じ名前を 2 度入れてはいけない)',
                ({ uri, state }) => {
                    expect(() =>
                        buildAuthzSuccessUrl(uri, { code: 'abc', state }),
                    ).toThrow(RangeError);
                },
            );

            it('元のクエリに state があっても、state を足さないなら、通る', () => {
                const uri = 'https://x.example.com/cb?state=1';

                expect(buildAuthzSuccessUrl(uri, { code: 'abc' })).toBe(
                    `${uri}&code=abc`,
                );
            });

            it.each([
                { name: '相対パス', uri: '/callback' },
                {
                    name: 'フラグメント付き(MUST NOT)',
                    uri: `${REDIRECT_URI}#frag`,
                },
                { name: '空のフラグメント付き', uri: `${REDIRECT_URI}#` },
                { name: 'http と https 以外', uri: 'ftp://x.example.com/cb' },
                { name: '空文字', uri: '' },
            ])('redirect_uri が不正: $name', ({ uri }) => {
                expect(() =>
                    buildAuthzSuccessUrl(uri, { code: 'abc' }),
                ).toThrow(RangeError);
            });
        });
    });

    describe('buildAuthzErrorUrl', () => {
        describe('作れる例', () => {
            it('error、error_description、state がつく(順番も、この通り)', () => {
                expect(
                    buildAuthzErrorUrl(REDIRECT_URI, {
                        error: 'access_denied',
                        description: 'denied',
                        state: 'xyz',
                    }),
                ).toBe(
                    `${REDIRECT_URI}?error=access_denied&error_description=denied&state=xyz`,
                );
            });

            it('description が無ければ、error_description はつかない', () => {
                const url = buildAuthzErrorUrl(REDIRECT_URI, {
                    error: 'access_denied',
                    state: 'xyz',
                });

                expect(url).toBe(
                    `${REDIRECT_URI}?error=access_denied&state=xyz`,
                );
                expect(paramsOf(url).has('error_description')).toBe(false);
            });

            it('state が無ければ、state はつかない', () => {
                expect(
                    buildAuthzErrorUrl(REDIRECT_URI, {
                        error: 'invalid_scope',
                    }),
                ).toBe(`${REDIRECT_URI}?error=invalid_scope`);
            });

            it.each([undefined, ''])(
                'state が %j なら、state はつかない',
                (state) => {
                    const url = buildAuthzErrorUrl(REDIRECT_URI, {
                        error: 'invalid_scope',
                        state,
                    });

                    expect(paramsOf(url).has('state')).toBe(false);
                },
            );

            it.each([
                'invalid_request',
                'unauthorized_client',
                'access_denied',
                'unsupported_response_type',
                'invalid_scope',
                'server_error',
                'temporarily_unavailable',
            ] as const)('エラー名がそのまま入る: %s', (error) => {
                const url = buildAuthzErrorUrl(REDIRECT_URI, { error });

                expect(paramsOf(url).get('error')).toBe(error);
            });

            it('エラーの URL には、code は入らない', () => {
                const url = buildAuthzErrorUrl(REDIRECT_URI, {
                    error: 'access_denied',
                    state: 'xyz',
                });

                expect(paramsOf(url).has('code')).toBe(false);
            });

            it('description の空白や記号は、エンコードされて、読み戻すと元に戻る', () => {
                const description = 'scope is not supported: admin (a&b=c)';

                const url = buildAuthzErrorUrl(REDIRECT_URI, {
                    error: 'invalid_scope',
                    description,
                });

                expect(paramsOf(url).get('error_description')).toBe(
                    description,
                );
            });

            it.each([
                { name: '空白 (0x20)', value: 'a b' },
                { name: '! (0x21)', value: 'a!b' },
                { name: '# (0x23)', value: 'a#b' },
                { name: '[ (0x5B)', value: 'a[b' },
                { name: '] (0x5D)', value: 'a]b' },
                { name: '~ (0x7E)', value: 'a~b' },
            ])(
                'description に使える文字の端(RFC 6749 4.1.2.1: %x20-21 / %x23-5B / %x5D-7E): $name',
                ({ value }) => {
                    const url = buildAuthzErrorUrl(REDIRECT_URI, {
                        error: 'access_denied',
                        description: value,
                    });

                    expect(paramsOf(url).get('error_description')).toBe(value);
                },
            );

            it('元のクエリは、そのまま残して、後ろに足す', () => {
                expect(
                    buildAuthzErrorUrl(REDIRECT_URI_WITH_QUERY, {
                        error: 'access_denied',
                        state: 'xyz',
                    }),
                ).toBe(
                    `${REDIRECT_URI_WITH_QUERY}&error=access_denied&state=xyz`,
                );
            });

            it('元のクエリに code があっても、エラーの URL では、重ならないので、通る', () => {
                const uri = 'https://x.example.com/cb?code=1';

                expect(
                    buildAuthzErrorUrl(uri, { error: 'access_denied' }),
                ).toBe(`${uri}&error=access_denied`);
            });
        });

        describe('RangeError になる場合', () => {
            it.each([
                { name: 'error', uri: 'https://x.example.com/cb?error=1' },
                {
                    name: 'error_description',
                    uri: 'https://x.example.com/cb?error_description=1',
                },
                { name: 'state', uri: 'https://x.example.com/cb?state=1' },
            ])(
                '元のクエリに、足すパラメータと同じ名前がある: $name',
                ({ uri }) => {
                    expect(() =>
                        buildAuthzErrorUrl(uri, {
                            error: 'access_denied',
                            description: 'denied',
                            state: 'xyz',
                        }),
                    ).toThrow(RangeError);
                },
            );

            it.each([
                { name: '相対パス', uri: '/callback' },
                { name: 'フラグメント付き', uri: `${REDIRECT_URI}#frag` },
                { name: 'http と https 以外', uri: 'javascript:alert(1)' },
                { name: '空文字', uri: '' },
            ])('redirect_uri が不正: $name', ({ uri }) => {
                expect(() =>
                    buildAuthzErrorUrl(uri, { error: 'access_denied' }),
                ).toThrow(RangeError);
            });

            it.each([
                { name: '空文字(1 文字以上が要る)', value: '' },
                { name: 'ダブルクォート (0x22)', value: 'a"b' },
                { name: 'バックスラッシュ (0x5C)', value: 'a\\b' },
                { name: 'タブ', value: 'a\tb' },
                { name: '改行', value: 'a\nb' },
                { name: 'DEL (0x7F)', value: 'a\x7Fb' },
                { name: '日本語', value: 'アクセス拒否' },
            ])('description に使えない文字: $name', ({ value }) => {
                expect(() =>
                    buildAuthzErrorUrl(REDIRECT_URI, {
                        error: 'access_denied',
                        description: value,
                    }),
                ).toThrow(RangeError);
            });
        });
    });
});
