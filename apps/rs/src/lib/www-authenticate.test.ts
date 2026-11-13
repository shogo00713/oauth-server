import { describe, it, expect } from 'vitest';
import { buildWwwAuthenticate } from './www-authenticate.js';

describe('WWW-AUTHENTICATE Bearer の挑戦(チャレンジ) RFC 6750 3', () => {
    describe('buildWwwAuthenticate', () => {
        describe('組み立て', () => {
            it('realm だけ(認証情報が無かった時。RFC 6750 3 の例と同じ形)', () => {
                expect(buildWwwAuthenticate({ realm: 'example' })).toBe(
                    'Bearer realm="example"',
                );
            });

            it('error と error_description(RFC 6750 3 の例と同じ形)', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: 'example',
                        error: 'invalid_token',
                        errorDescription: 'The access token expired',
                    }),
                ).toBe(
                    'Bearer realm="example", error="invalid_token", error_description="The access token expired"',
                );
            });

            it('error だけ(説明は省略できる)', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: 'example',
                        error: 'invalid_request',
                    }),
                ).toBe('Bearer realm="example", error="invalid_request"');
            });

            it.each([
                'invalid_request',
                'invalid_token',
                'insufficient_scope',
            ] as const)('error の値は、そのまま入る: %s', (error) => {
                expect(buildWwwAuthenticate({ realm: 'example', error })).toBe(
                    `Bearer realm="example", error="${error}"`,
                );
            });

            it('scope が 1 つ(足りないスコープを伝える)', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: 'example',
                        error: 'insufficient_scope',
                        scope: ['write'],
                    }),
                ).toBe(
                    'Bearer realm="example", scope="write", error="insufficient_scope"',
                );
            });

            it('scope が複数なら、空白で区切って、1 つの値にまとめる', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: 'example',
                        scope: ['read', 'write'],
                    }),
                ).toBe('Bearer realm="example", scope="read write"');
            });

            it('全部指定した時の、並び順は、realm、scope、error、error_description', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: 'simple-memo',
                        error: 'insufficient_scope',
                        errorDescription: 'Write scope is required',
                        scope: ['write'],
                    }),
                ).toBe(
                    'Bearer realm="simple-memo", scope="write", error="insufficient_scope", error_description="Write scope is required"',
                );
            });

            it('値は、全部ダブルクォートで囲む', () => {
                const header = buildWwwAuthenticate({
                    realm: 'r',
                    error: 'invalid_token',
                    errorDescription: 'd',
                    scope: ['s'],
                });

                expect(header).toMatch(/realm="r"/);
                expect(header).toMatch(/scope="s"/);
                expect(header).toMatch(/error="invalid_token"/);
                expect(header).toMatch(/error_description="d"/);
            });

            it('同じ属性は、2 回出ない', () => {
                const header = buildWwwAuthenticate({
                    realm: 'example',
                    error: 'invalid_token',
                    errorDescription: 'The access token expired',
                    scope: ['read', 'write'],
                });

                for (const name of [
                    'realm',
                    'scope',
                    'error',
                    'error_description',
                ])
                    expect(header.split(`${name}=`)).toHaveLength(2);
            });
        });

        describe('使える文字(RFC 6750 3)', () => {
            it('realm と error_description は、空白と、記号も使える(" と \\ 以外の、表示できる ASCII)', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: "My Memo: ~!#$%&'()*+,-./:;<=>?@[]^_`{|}~",
                        error: 'invalid_token',
                        errorDescription: 'Token (id=abc) is invalid, sorry.',
                    }),
                ).toBe(
                    'Bearer realm="My Memo: ~!#$%&\'()*+,-./:;<=>?@[]^_`{|}~", error="invalid_token", error_description="Token (id=abc) is invalid, sorry."',
                );
            });

            it('scope は、コロンやドットも使える', () => {
                expect(
                    buildWwwAuthenticate({
                        realm: 'example',
                        scope: ['memo:read', 'memo.write', 'a_b-c'],
                    }),
                ).toBe(
                    'Bearer realm="example", scope="memo:read memo.write a_b-c"',
                );
            });
        });

        describe('不正な値は、RangeError(ヘッダーを壊さない、注入させない)', () => {
            it.each([
                { name: '空', value: '' },
                { name: 'ダブルクォート', value: 'my"realm' },
                { name: 'バックスラッシュ', value: 'my\\realm' },
                { name: '改行(ヘッダーの注入)', value: 'x\r\nSet-Cookie: a=b' },
                { name: '改行だけ', value: 'x\ny' },
                { name: 'タブ', value: 'x\ty' },
                { name: '日本語', value: 'メモ' },
                { name: 'DEL(0x7F)', value: 'x\x7Fy' },
            ])('realm: $name', ({ value }) => {
                expect(() => buildWwwAuthenticate({ realm: value })).toThrow(
                    RangeError,
                );
            });

            it.each([
                { name: '空', value: '' },
                { name: 'ダブルクォート', value: 'say "hi"' },
                { name: 'バックスラッシュ', value: 'a\\b' },
                { name: '改行(ヘッダーの注入)', value: 'x\r\nSet-Cookie: a=b' },
                { name: 'タブ', value: 'x\ty' },
                { name: '日本語', value: 'トークンが切れています' },
            ])('error_description: $name', ({ value }) => {
                expect(() =>
                    buildWwwAuthenticate({
                        realm: 'example',
                        error: 'invalid_token',
                        errorDescription: value,
                    }),
                ).toThrow(RangeError);
            });

            it('error_description だけで、error が無い', () => {
                expect(() =>
                    buildWwwAuthenticate({
                        realm: 'example',
                        errorDescription: 'The access token expired',
                    }),
                ).toThrow(RangeError);
            });

            it('scope が空の配列', () => {
                expect(() =>
                    buildWwwAuthenticate({ realm: 'example', scope: [] }),
                ).toThrow(RangeError);
            });

            it.each([
                { name: '空のスコープ', scope: [''] },
                {
                    name: '空白を含む(2 つに分かれてしまう)',
                    scope: ['read write'],
                },
                { name: '1 つだけ空', scope: ['read', ''] },
                { name: 'ダブルクォート', scope: ['re"ad'] },
                { name: 'バックスラッシュ', scope: ['re\\ad'] },
                { name: '改行', scope: ['read\r\nX: 1'] },
                { name: 'タブ', scope: ['re\tad'] },
                { name: '日本語', scope: ['読む'] },
            ])('scope: $name', ({ scope }) => {
                expect(() =>
                    buildWwwAuthenticate({ realm: 'example', scope }),
                ).toThrow(RangeError);
            });

            it('不正な値が入っていたら、他の値が正しくても、エラー', () => {
                expect(() =>
                    buildWwwAuthenticate({
                        realm: 'example',
                        error: 'invalid_token',
                        errorDescription: 'bad "quote"',
                        scope: ['read'],
                    }),
                ).toThrow(RangeError);
            });
        });

        describe('入力を壊さない', () => {
            it('scope の配列は、書き換えない', () => {
                const scope = ['read', 'write'];

                buildWwwAuthenticate({ realm: 'example', scope });

                expect(scope).toEqual(['read', 'write']);
            });
        });
    });
});
