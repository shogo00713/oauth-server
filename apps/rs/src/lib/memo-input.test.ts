import { describe, expect, it } from 'vitest';
import { MAX_BODY_LENGTH, parseMemoInput } from './memo-input.js';

describe('MEMO-INPUT メモの入力検証(zod)', () => {
    it('最大の文字数は、10000', () => {
        expect(MAX_BODY_LENGTH).toBe(10_000);
    });

    describe('parseMemoInput', () => {
        describe('正しい入力', () => {
            it('{ body } が、そのまま返る', () => {
                expect(parseMemoInput({ body: 'hello' })).toEqual({
                    body: 'hello',
                });
            });

            it('1 文字でも、良い', () => {
                expect(parseMemoInput({ body: 'a' })).toEqual({ body: 'a' });
            });

            it('最大の文字数ちょうどは、良い', () => {
                const body = 'a'.repeat(MAX_BODY_LENGTH);

                expect(parseMemoInput({ body })).toEqual({ body });
            });

            it.each([
                { name: '日本語', body: '買い物: 牛乳と卵' },
                { name: '改行を含む', body: '1 行目\n2 行目\r\n3 行目' },
                {
                    name: '記号や HTML のような文字',
                    body: '<b>"a" & \'b\'</b>',
                },
                { name: '前後に空白がある', body: '  前後の空白  ' },
                { name: 'タブを含む', body: 'a\tb' },
            ])('本文は加工しない: $name', ({ body }) => {
                expect(parseMemoInput({ body })).toEqual({ body });
            });

            it('渡した物とは別の、新しい物を返す', () => {
                const input = { body: 'hello' };

                const result = parseMemoInput(input);

                expect(result).not.toBe(input);
            });

            it('渡した物を、書き換えない', () => {
                const input = { body: 'hello', extra: 1 };

                parseMemoInput(input);

                expect(input).toEqual({ body: 'hello', extra: 1 });
            });
        });

        describe('文字数の数え方(Unicode の文字の数)', () => {
            it('絵文字は、1 文字として数える(最大の文字数ちょうどは、良い)', () => {
                const body = '😀'.repeat(MAX_BODY_LENGTH);

                expect(parseMemoInput({ body })).toEqual({ body });
            });

            it('絵文字でも、最大を 1 文字超えたら、断る', () => {
                const body = '😀'.repeat(MAX_BODY_LENGTH + 1);

                expect(parseMemoInput({ body })).toBeNull();
            });

            it('最大を 1 文字超えたら、断る', () => {
                const body = 'a'.repeat(MAX_BODY_LENGTH + 1);

                expect(parseMemoInput({ body })).toBeNull();
            });
        });

        describe('知らない項目は、捨てる(持ち主や id を、クライアントに決めさせない)', () => {
            it('owner、id、日時が付いていても、body だけが残る', () => {
                const result = parseMemoInput({
                    body: 'hello',
                    owner: 'someone-else',
                    id: 'fixed-id',
                    createdAt: '2000-01-01T00:00:00.000Z',
                    updatedAt: '2000-01-01T00:00:00.000Z',
                });

                expect(result).toEqual({ body: 'hello' });
                expect(Object.keys(result ?? {})).toEqual(['body']);
            });

            it('__proto__ を持つ JSON でも、body だけが残って、Object.prototype は汚れない', () => {
                const raw: unknown = JSON.parse(
                    '{"body":"hello","__proto__":{"admin":true}}',
                );

                const result = parseMemoInput(raw);

                expect(result).toEqual({ body: 'hello' });
                expect(Object.keys(result ?? {})).toEqual(['body']);
                expect((result as Record<string, unknown>)['admin']).toBe(
                    undefined,
                );
                expect(({} as Record<string, unknown>)['admin']).toBe(
                    undefined,
                );
            });
        });

        describe('正しくない入力は、null', () => {
            it('body が空文字', () => {
                expect(parseMemoInput({ body: '' })).toBeNull();
            });

            it.each([
                { name: 'body が無い', raw: {} },
                { name: 'body が undefined', raw: { body: undefined } },
                { name: 'body が null', raw: { body: null } },
                { name: 'body が数値', raw: { body: 1 } },
                { name: 'body が真偽値', raw: { body: true } },
                { name: 'body が配列', raw: { body: ['a'] } },
                { name: 'body がオブジェクト', raw: { body: { a: 'b' } } },
                { name: 'キーの大文字小文字が違う', raw: { Body: 'a' } },
                { name: '別のキーだけ', raw: { text: 'a' } },
            ])('$name', ({ raw }) => {
                expect(parseMemoInput(raw)).toBeNull();
            });

            it.each([
                { name: 'undefined(本文が読めなかった)', raw: undefined },
                { name: 'null', raw: null },
                { name: '配列', raw: [{ body: 'a' }] },
                { name: '文字列', raw: 'a' },
                { name: '数値', raw: 12 },
                { name: '真偽値', raw: true },
            ])('全体が、オブジェクトではない: $name', ({ raw }) => {
                expect(parseMemoInput(raw)).toBeNull();
            });
        });
    });
});
