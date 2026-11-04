import { describe, it, expect } from 'vitest';
import { parseScope, isSubsetScope, formatScope } from './scope.js';

describe('SCOPE RFC 6749', () => {
    describe('parseScope', () => {
        describe('正しい例', () => {
            it('read を 1 つ渡すと、配列で返る', () => {
                expect(parseScope('read')).toEqual(['read']);
            });

            it.each(['read write', 'write read'])(
                'read と write を渡すと、配列に変わる: %s',
                (value) => {
                    expect(parseScope(value)).toEqual(['read', 'write']);
                },
            );

            it.each(['a:b', 'https://example.com/scope', 'read.memo'])(
                '変なスコープの値は、1 つのトークンとして配列になる: %s',
                (value) => {
                    expect(parseScope(value)).toEqual([value]);
                },
            );

            it('カンマでは分割されない', () => {
                expect(parseScope('read,write')).toEqual(['read,write']);
            });

            it('大文字のスコープも、そのまま配列で返る', () => {
                expect(parseScope('READ')).toEqual(['READ']);
            });
        });

        describe('null が返る場合', () => {
            it('空文字', () => {
                expect(parseScope('')).toBeNull();
            });

            it('空白だけ', () => {
                expect(parseScope(' ')).toBeNull();
            });

            it.each([' read', 'read '])(
                '先頭か末尾に空白がある: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it.each(['read  write', 'read   write'])(
                'スコープの間に空白が 2 つ以上ある: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it.each(['read\twrite', 'read\nwrite', 'read\n'])(
                '制御文字 (タブ・改行) を含んでいる: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it.each(['re"ad', 're\\ad'])(
                'ダブルクォーテーションかバックスラッシュを使っている: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it('ASCII 以外の文字を使っている', () => {
                expect(parseScope('読む')).toBeNull();
            });

            it('制御文字を含んでいる', () => {
                expect(parseScope('read\u007f')).toBeNull();
            });

            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: ['read'] },
                { name: 'String オブジェクト', value: new String('read') },
            ])('文字列以外の値: $name', ({ value }) => {
                expect(parseScope(value)).toBeNull();
            });
        });
    });
    describe('isSubsetScope', () => {
        describe('true になる場合', () => {
            it('同じスコープなら、true', () => {
                expect(isSubsetScope(['read'], ['read'])).toBe(true);
            });

            it('許可の部分集合なら、true', () => {
                expect(isSubsetScope(['read'], ['read', 'write'])).toBe(true);
            });
            it('重複でもOK', () => {
                expect(isSubsetScope(['read', 'read'], ['read'])).toBe(true);
            });
            it('順序違い', () => {
                expect(
                    isSubsetScope(['write', 'read'], ['read', 'write']),
                ).toBe(true);
            });
        });

        describe('false になる場合', () => {
            it('許可より大きい集合を要求している', () => {
                expect(isSubsetScope(['read', 'write'], ['read'])).toBe(false);
            });

            it('違うものを要求している', () => {
                expect(isSubsetScope(['admin'], ['read', 'write'])).toBe(false);
            });

            it('違うものが 1 つ混ざっている', () => {
                expect(
                    isSubsetScope(['read', 'admin'], ['read', 'write']),
                ).toBe(false);
            });

            it('大文字小文字が違う', () => {
                expect(isSubsetScope(['READ'], ['read'])).toBe(false);
            });

            it('前方一致するけど、違うスコープ', () => {
                expect(isSubsetScope(['rea'], ['read'])).toBe(false);
                expect(isSubsetScope(['readx'], ['read'])).toBe(false);
            });

            it('要求が空配列', () => {
                expect(isSubsetScope([], ['read'])).toBe(false);
            });

            it('許可が空配列', () => {
                expect(isSubsetScope(['read'], [])).toBe(false);
            });
        });
    });

    describe('formatScope', () => {
        it('read だけの配列は、read だけの文字列になる', () => {
            expect(formatScope(['read'])).toBe('read');
        });

        it('read と write の配列は、半角スペースでつながる', () => {
            expect(formatScope(['read', 'write'])).toBe('read write');
        });

        it('parseScope に戻すと、元の配列に戻る', () => {
            expect(parseScope(formatScope(['read', 'write']))).toEqual([
                'read',
                'write',
            ]);
        });

        it('空配列は、RangeError を投げる', () => {
            expect(() => formatScope([])).toThrow(RangeError);
        });
    });
});
