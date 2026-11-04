import { describe, it, expect } from 'vitest';
import { readParam } from './params.js';

describe('PARAMS RFC 6749 3.2', () => {
    describe('readParam', () => {
        describe('値が取れる例', () => {
            it('1 回だけ書かれた文字列は、そのまま返る', () => {
                expect(readParam({ code: 'abc' }, 'code')).toBe('abc');
            });

            it('空白だけの値は、値として返る(空文字とは違う)', () => {
                expect(readParam({ code: ' ' }, 'code')).toBe(' ');
            });

            it('前後の空白は、取り除かない', () => {
                expect(readParam({ code: ' abc ' }, 'code')).toBe(' abc ');
            });

            it('指定した名前の値だけを返す', () => {
                expect(readParam({ code: 'abc', state: 'xyz' }, 'state')).toBe(
                    'xyz',
                );
            });

            it('プロトタイプのないオブジェクトでも、取れる', () => {
                const source = Object.assign(Object.create(null), {
                    code: 'abc',
                });
                expect(readParam(source, 'code')).toBe('abc');
            });
        });

        describe('省略扱い(undefined)', () => {
            it('名前がない', () => {
                expect(readParam({}, 'code')).toBeUndefined();
            });

            it('値が空文字(値のないパラメータは、省略されたものとして扱う)', () => {
                expect(readParam({ code: '' }, 'code')).toBeUndefined();
            });

            it('名前の大文字小文字が違う', () => {
                expect(readParam({ Code: 'abc' }, 'code')).toBeUndefined();
            });

            it.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
                '継承されたプロパティは、ないものとして扱う: %s',
                (name) => {
                    expect(readParam({}, name)).toBeUndefined();
                },
            );
        });

        describe('null が返る場合', () => {
            it.each([
                { name: '2 回', value: ['a', 'b'] },
                { name: '1 つだけの配列', value: ['a'] },
                { name: '空の配列', value: [] },
            ])('パラメータが繰り返されている: $name', ({ value }) => {
                expect(readParam({ code: value }, 'code')).toBeNull();
            });

            it.each([
                { name: 'null', value: null },
                { name: '数値', value: 12 },
                { name: '真偽値', value: true },
                { name: 'オブジェクト', value: { a: 'b' } },
            ])('値が文字列ではない: $name', ({ value }) => {
                expect(readParam({ code: value }, 'code')).toBeNull();
            });

            it.each([
                { name: 'null', source: null },
                { name: 'undefined', source: undefined },
                { name: '文字列', source: 'code=abc' },
                { name: '数値', source: 12 },
                { name: '配列', source: ['code'] },
            ])('取り出し元がオブジェクトではない: $name', ({ source }) => {
                expect(readParam(source, 'code')).toBeNull();
            });
        });
    });
});
