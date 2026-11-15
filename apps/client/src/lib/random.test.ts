import { describe, expect, it } from 'vitest';
import { generateRandomString } from './random.js';

describe('random RFC 6749 10.10', () => {
    it('32 を渡すと 32 バイト (= 43 文字) のランダム文字列を生成する', () => {
        expect(generateRandomString(32)).toHaveLength(43);
    });
    it('ランダム文字列は、1000回生成しても、全て英数字と _ - のみで構成される', () => {
        const regex = /^[A-Za-z0-9_-]+$/;
        for (let i = 0; i < 1000; i++) {
            const str = generateRandomString(16);
            expect(str).toMatch(regex);
        }
    });
    it('ランダム文字列は、1000回生成しても、すべて異なる値を返す', () => {
        const results = Array.from({ length: 1000 }, () =>
            generateRandomString(32),
        );
        expect(new Set(results).size).toBe(1000);
    });
    it('引数の規定値は 32 bytes', () => {
        expect(generateRandomString()).toHaveLength(43);
    });
    it.each([0, 1, 15])(
        '15 以下の値を引数に与えると、RangeError を投げる',
        (value) => {
            expect(() => generateRandomString(value)).toThrow(RangeError);
        },
    );
    it('16 を引数に渡すと、正しく動く', () => {
        expect(generateRandomString(16)).toHaveLength(22);
    });
    it.each([0.1, 16.5, NaN, Infinity] as number[])(
        '引数に整数以外の値を与えると、RangeError を投げる',
        (value) => {
            expect(() => generateRandomString(value)).toThrow(RangeError);
        },
    );
    it.each(['a', true, false, null])(
        '引数に数値以外の値を与えると、TypeError を投げる',
        (value) => {
            expect(() => generateRandomString(value as any)).toThrow(TypeError);
        },
    );
});
