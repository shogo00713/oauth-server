import { describe, expect, it } from 'vitest';
import {
    MAX_BODY_LENGTH,
    MAX_QUERY_LENGTH,
    parseMemoBody,
    parseSearchQuery,
} from './memo-form.js';

// 見た目では、区別しにくい空白。コードの中に直接書かずに、番号で作る
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const NO_BREAK_SPACE = String.fromCodePoint(0xa0);

describe('MEMO FORM フォームから届いた、本文と検索語', () => {
    describe('上限', () => {
        it('本文は 10000 文字(RS と同じ)、検索語は 200 文字', () => {
            expect(MAX_BODY_LENGTH).toBe(10_000);
            expect(MAX_QUERY_LENGTH).toBe(200);
        });
    });

    describe('parseMemoBody', () => {
        describe('受け付ける本文', () => {
            it('普通の文は、そのまま返す', () => {
                expect(parseMemoBody('牛乳を買う')).toEqual({
                    ok: true,
                    body: '牛乳を買う',
                });
            });

            it('前後の空白や改行は、そのまま残す', () => {
                expect(parseMemoBody('  hello  \n')).toEqual({
                    ok: true,
                    body: '  hello  \n',
                });
                expect(parseMemoBody('\n\nhello')).toEqual({
                    ok: true,
                    body: '\n\nhello',
                });
            });

            it('本文の中の空白や、空行も、そのまま残す', () => {
                expect(parseMemoBody('a  b\n\n\nc')).toEqual({
                    ok: true,
                    body: 'a  b\n\n\nc',
                });
            });

            it('HTML や記号も、そのまま返す(エスケープは、画面の仕事)', () => {
                expect(
                    parseMemoBody('<script>alert(1)</script> & "x"'),
                ).toEqual({
                    ok: true,
                    body: '<script>alert(1)</script> & "x"',
                });
            });
        });

        describe('改行を LF にそろえる(ブラウザは、CRLF で送ってくる)', () => {
            it.each([
                { name: 'CRLF', value: 'a\r\nb', expected: 'a\nb' },
                { name: 'CR だけ', value: 'a\rb', expected: 'a\nb' },
                { name: 'LF', value: 'a\nb', expected: 'a\nb' },
                {
                    name: 'まざっている',
                    value: 'a\r\nb\rc\nd\r\n\r\ne',
                    expected: 'a\nb\nc\nd\n\ne',
                },
                { name: '末尾が CRLF', value: 'a\r\n', expected: 'a\n' },
            ])('$name', ({ value, expected }) => {
                expect(parseMemoBody(value)).toEqual({
                    ok: true,
                    body: expected,
                });
            });
        });

        describe('届かなかった、空の本文', () => {
            it('undefined(項目が無い、または空文字)なら、empty', () => {
                expect(parseMemoBody(undefined)).toEqual({
                    ok: false,
                    reason: 'empty',
                });
            });

            it.each([
                { name: '空文字', value: '' },
                { name: '半角の空白', value: '   ' },
                { name: '全角の空白', value: IDEOGRAPHIC_SPACE.repeat(3) },
                { name: 'NBSP', value: NO_BREAK_SPACE },
                { name: 'タブと改行', value: '\t\n\r\n' },
                {
                    name: 'いろいろまざった空白',
                    value: ` \t${IDEOGRAPHIC_SPACE}\r\n`,
                },
            ])('$name だけなら、empty', ({ value }) => {
                expect(parseMemoBody(value)).toEqual({
                    ok: false,
                    reason: 'empty',
                });
            });
        });

        describe('文字列じゃない', () => {
            it('null(2 回ある、など)なら、malformed', () => {
                expect(parseMemoBody(null)).toEqual({
                    ok: false,
                    reason: 'malformed',
                });
            });
        });

        describe('長さ(Unicode の文字の数。RS と同じ数え方)', () => {
            it('10000 文字ちょうどは、良い', () => {
                const body = 'a'.repeat(MAX_BODY_LENGTH);

                expect(parseMemoBody(body)).toEqual({ ok: true, body });
            });

            it('10001 文字なら、too_long', () => {
                expect(parseMemoBody('a'.repeat(MAX_BODY_LENGTH + 1))).toEqual({
                    ok: false,
                    reason: 'too_long',
                });
            });

            it('絵文字は、1 文字として数える(10000 個ちょうどは、良い)', () => {
                const body = '😀'.repeat(MAX_BODY_LENGTH);

                expect(parseMemoBody(body)).toEqual({ ok: true, body });
            });

            it('絵文字でも、10001 個なら、too_long', () => {
                expect(parseMemoBody('😀'.repeat(MAX_BODY_LENGTH + 1))).toEqual(
                    {
                        ok: false,
                        reason: 'too_long',
                    },
                );
            });

            it('数えるのは、改行をそろえた後(CRLF は、1 文字)', () => {
                // 9999 文字 + CRLF は、そろえる前は 10001、そろえた後は 10000
                const value = `${'a'.repeat(MAX_BODY_LENGTH - 1)}\r\n`;

                expect(parseMemoBody(value)).toEqual({
                    ok: true,
                    body: `${'a'.repeat(MAX_BODY_LENGTH - 1)}\n`,
                });
            });

            it('空白だけの判定は、長さより先(長い空白だけでも、empty)', () => {
                expect(parseMemoBody(' '.repeat(MAX_BODY_LENGTH + 1))).toEqual({
                    ok: false,
                    reason: 'empty',
                });
            });
        });
    });

    describe('parseSearchQuery', () => {
        it('普通の検索語は、そのまま返す', () => {
            expect(parseSearchQuery('牛乳 卵')).toEqual({
                ok: true,
                query: '牛乳 卵',
            });
        });

        it('検索語の中の空白は、そのまま残す', () => {
            expect(parseSearchQuery('a   b')).toEqual({
                ok: true,
                query: 'a   b',
            });
        });

        it.each([
            { name: '半角の空白', value: '  牛乳  ', expected: '牛乳' },
            {
                name: '全角の空白',
                value: `${IDEOGRAPHIC_SPACE}牛乳${IDEOGRAPHIC_SPACE}`,
                expected: '牛乳',
            },
            { name: 'タブと改行', value: '\t牛乳\n', expected: '牛乳' },
        ])('前後の $name は、取る', ({ value, expected }) => {
            expect(parseSearchQuery(value)).toEqual({
                ok: true,
                query: expected,
            });
        });

        it.each([
            { name: 'undefined(項目が無い、または空)', value: undefined },
            { name: '空文字', value: '' },
            { name: '空白だけ', value: '   ' },
            { name: '全角の空白だけ', value: IDEOGRAPHIC_SPACE },
        ])('$name なら、検索しない(空文字)', ({ value }) => {
            expect(parseSearchQuery(value)).toEqual({ ok: true, query: '' });
        });

        it('null(2 回ある、など)なら、使えない', () => {
            expect(parseSearchQuery(null)).toEqual({ ok: false });
        });

        it('200 文字ちょうどは、良い。201 文字なら、使えない', () => {
            expect(parseSearchQuery('a'.repeat(MAX_QUERY_LENGTH))).toEqual({
                ok: true,
                query: 'a'.repeat(MAX_QUERY_LENGTH),
            });
            expect(parseSearchQuery('a'.repeat(MAX_QUERY_LENGTH + 1))).toEqual({
                ok: false,
            });
        });

        it('数えるのは、前後の空白を取った後(200 文字 + 空白は、良い)', () => {
            const query = 'a'.repeat(MAX_QUERY_LENGTH);

            expect(parseSearchQuery(`  ${query}  `)).toEqual({
                ok: true,
                query,
            });
        });

        it('絵文字は、1 文字として数える', () => {
            expect(parseSearchQuery('😀'.repeat(MAX_QUERY_LENGTH))).toEqual({
                ok: true,
                query: '😀'.repeat(MAX_QUERY_LENGTH),
            });
            expect(parseSearchQuery('😀'.repeat(MAX_QUERY_LENGTH + 1))).toEqual(
                {
                    ok: false,
                },
            );
        });
    });
});
