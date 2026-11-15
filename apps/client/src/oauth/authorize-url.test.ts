import { describe, expect, it } from 'vitest';
import { buildAuthorizeUrl, type AuthorizeUrlInput } from './authorize-url.js';

// RFC 7636 付録 B の code_challenge(43 文字)
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const input = (
    overrides: Partial<AuthorizeUrlInput> = {},
): AuthorizeUrlInput => ({
    authorizationEndpoint: 'http://localhost:4000/authorize',
    clientId: 'memoboard',
    redirectUri: 'http://localhost:4001/callback',
    scope: 'read write',
    state: 'state-123',
    codeChallenge: CHALLENGE,
    ...overrides,
});

const paramsOf = (url: string) => new URL(url).searchParams;

describe('AUTHORIZE-URL 認可リクエストの URL RFC 6749 4.1.1 / RFC 7636 4.3', () => {
    describe('buildAuthorizeUrl', () => {
        describe('組み立て', () => {
            it('認可エンドポイントの場所は、そのまま。7 つのパラメータが、付く', () => {
                const url = new URL(buildAuthorizeUrl(input()));

                expect(`${url.origin}${url.pathname}`).toBe(
                    'http://localhost:4000/authorize',
                );
                expect(Object.fromEntries(url.searchParams)).toEqual({
                    response_type: 'code',
                    client_id: 'memoboard',
                    redirect_uri: 'http://localhost:4001/callback',
                    scope: 'read write',
                    state: 'state-123',
                    code_challenge: CHALLENGE,
                    code_challenge_method: 'S256',
                });
            });

            it('どのパラメータも、1 回だけ(RFC 6749 3.1)', () => {
                const params = paramsOf(buildAuthorizeUrl(input()));

                for (const name of new Set(params.keys()))
                    expect(params.getAll(name)).toHaveLength(1);
            });

            it('https の、ポートとパスがあるエンドポイントでも、そのまま', () => {
                const url = new URL(
                    buildAuthorizeUrl(
                        input({
                            authorizationEndpoint:
                                'https://as.example.com:8443/oauth/authorize',
                        }),
                    ),
                );

                expect(url.origin).toBe('https://as.example.com:8443');
                expect(url.pathname).toBe('/oauth/authorize');
            });

            it('結果は、そのまま、リダイレクトの Location に使える文字列(空白や、# を含まない)', () => {
                const result = buildAuthorizeUrl(input());

                expect(result).not.toMatch(/\s/);
                expect(result).not.toContain('#');
                expect(URL.canParse(result)).toBe(true);
            });
        });

        describe('元からあるクエリ(RFC 6749 3.1: 残す)', () => {
            it('元のクエリは、残る', () => {
                const params = paramsOf(
                    buildAuthorizeUrl(
                        input({
                            authorizationEndpoint:
                                'http://localhost:4000/authorize?tenant=acme&lang=ja',
                        }),
                    ),
                );

                expect(params.get('tenant')).toBe('acme');
                expect(params.get('lang')).toBe('ja');
                expect(params.get('client_id')).toBe('memoboard');
            });

            it('元のクエリに、こちらが付けるパラメータと同じ名前があっても、1 つにして、こちらの値にする', () => {
                const params = paramsOf(
                    buildAuthorizeUrl(
                        input({
                            authorizationEndpoint:
                                'http://localhost:4000/authorize?state=evil&client_id=other&scope=admin&client_id=other2',
                        }),
                    ),
                );

                expect(params.getAll('state')).toEqual(['state-123']);
                expect(params.getAll('client_id')).toEqual(['memoboard']);
                expect(params.getAll('scope')).toEqual(['read write']);
            });
        });

        describe('値の組み込み(URL として、安全に)', () => {
            it.each([
                { name: '& と =', value: 'a&b=c' },
                { name: '#', value: 'a#b' },
                { name: '+', value: 'a+b' },
                { name: '空白', value: 'a b' },
                { name: '%', value: '100%' },
                { name: '%20 という文字列', value: 'a%20b' },
                { name: '?', value: 'a?b' },
                { name: '日本語', value: '日本語の state' },
                { name: '引用符', value: '"quoted"' },
            ])('state に $name が入っていても、そのまま戻る', ({ value }) => {
                const result = buildAuthorizeUrl(input({ state: value }));

                expect(paramsOf(result).get('state')).toBe(value);
                // 値の中の & や # が、別のパラメータや、フラグメントにならない
                expect(new URL(result).hash).toBe('');
                expect(paramsOf(result).getAll('state')).toHaveLength(1);
            });

            it('redirect_uri に、クエリ(& を含む)が付いていても、1 つの値として戻る', () => {
                const redirectUri =
                    'http://localhost:4001/callback?next=/home&x=1';

                const result = buildAuthorizeUrl(input({ redirectUri }));

                expect(paramsOf(result).get('redirect_uri')).toBe(redirectUri);
                expect(paramsOf(result).has('next')).toBe(false);
                expect(paramsOf(result).has('x')).toBe(false);
            });

            it('scope の空白は、区切りとして戻る(read write)', () => {
                const result = buildAuthorizeUrl(
                    input({ scope: 'read write' }),
                );

                expect(paramsOf(result).get('scope')).toBe('read write');
            });

            it('値に、パラメータの名前のような文字(&client_id=evil)が入っていても、別のパラメータにならない', () => {
                const result = buildAuthorizeUrl(
                    input({
                        state: 'x&client_id=evil&redirect_uri=http://evil',
                    }),
                );

                expect(paramsOf(result).getAll('client_id')).toEqual([
                    'memoboard',
                ]);
                expect(paramsOf(result).get('redirect_uri')).toBe(
                    'http://localhost:4001/callback',
                );
            });
        });

        describe('不正な入力は、RangeError', () => {
            it.each([
                { name: '空文字', value: '' },
                { name: '絶対 URL ではない', value: '/authorize' },
                { name: 'ホストだけ', value: 'localhost:4000/authorize' },
                {
                    name: 'http と https 以外(ftp)',
                    value: 'ftp://x.example.com/a',
                },
                { name: 'javascript:', value: 'javascript:alert(1)' },
                {
                    name: 'フラグメント付き(RFC 6749 3.1)',
                    value: 'http://localhost:4000/authorize#frag',
                },
                {
                    name: '空のフラグメント付き',
                    value: 'http://localhost:4000/authorize#',
                },
            ])('認可エンドポイントが、$name', ({ value }) => {
                expect(() =>
                    buildAuthorizeUrl(input({ authorizationEndpoint: value })),
                ).toThrow(RangeError);
            });

            it.each([
                { name: '空文字', value: '' },
                { name: '絶対 URL ではない', value: '/callback' },
                { name: 'http と https 以外', value: 'myapp://callback' },
                {
                    name: 'フラグメント付き',
                    value: 'http://localhost:4001/cb#x',
                },
            ])('redirect_uri が、$name', ({ value }) => {
                expect(() =>
                    buildAuthorizeUrl(input({ redirectUri: value })),
                ).toThrow(RangeError);
            });

            it.each([
                { name: 'client_id が空', overrides: { clientId: '' } },
                { name: 'scope が空', overrides: { scope: '' } },
                { name: 'state が空', overrides: { state: '' } },
            ])('$name', ({ overrides }) => {
                expect(() => buildAuthorizeUrl(input(overrides))).toThrow(
                    RangeError,
                );
            });

            it.each([
                { name: '空', value: '' },
                { name: '42 文字(短い)', value: 'A'.repeat(42) },
                { name: '44 文字(長い)', value: 'A'.repeat(44) },
                { name: '+ を含む', value: 'A'.repeat(42) + '+' },
                { name: '/ を含む', value: 'A'.repeat(42) + '/' },
                { name: 'パディング(=)付き', value: 'A'.repeat(42) + '=' },
                {
                    name: '. を含む(code_verifier の文字)',
                    value: 'A'.repeat(42) + '.',
                },
            ])('code_challenge が、$name', ({ value }) => {
                expect(() =>
                    buildAuthorizeUrl(input({ codeChallenge: value })),
                ).toThrow(RangeError);
            });
        });

        it('渡した物を、書き換えない', () => {
            const original = input();
            const copy = { ...original };

            buildAuthorizeUrl(original);

            expect(original).toEqual(copy);
        });
    });
});
