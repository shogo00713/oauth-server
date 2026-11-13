import { describe, expect, it } from 'vitest';
import {
    ensureCsrfToken,
    generateCsrfToken,
    isValidCsrfToken,
} from './csrf.js';

const TOKEN = 'k3J9xQ2mZpL7vR1tY8wN5cB4hG6dF0aS_-eUoIyXzMq';

describe('CSRF フォームに埋めるトークン RFC 6749 10.12', () => {
    describe('generateCsrfToken', () => {
        it('43 文字の Base64URL(256 ビット)', () => {
            const token = generateCsrfToken();

            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(Buffer.from(token, 'base64url')).toHaveLength(32);
        });

        it('呼ぶたびに違う(1000 回で、全部違う)', () => {
            const tokens = new Set(
                Array.from({ length: 1000 }, () => generateCsrfToken()),
            );

            expect(tokens.size).toBe(1000);
        });
    });

    describe('isValidCsrfToken', () => {
        describe('true になる場合', () => {
            it('同じトークン', () => {
                expect(isValidCsrfToken(TOKEN, TOKEN)).toBe(true);
            });

            it('作ったトークンを、そのまま比べる', () => {
                const token = generateCsrfToken();

                expect(isValidCsrfToken(token, token)).toBe(true);
                expect(isValidCsrfToken(token, String(token))).toBe(true);
            });

            it('日本語など、バイト数が 2 つ以上の文字でも、同じなら true', () => {
                expect(isValidCsrfToken('あいう', 'あいう')).toBe(true);
            });
        });

        describe('false になる場合', () => {
            it.each([
                {
                    name: '最後の 1 文字が違う',
                    value: `${TOKEN.slice(0, -1)}x`,
                },
                { name: '最初の 1 文字が違う', value: `x${TOKEN.slice(1)}` },
                {
                    name: '真ん中の 1 文字が違う',
                    value: `${TOKEN.slice(0, 20)}x${TOKEN.slice(21)}`,
                },
                { name: '大文字小文字が違う', value: TOKEN.toUpperCase() },
            ])('同じ長さの、違うトークン: $name', ({ value }) => {
                expect(value).toHaveLength(TOKEN.length);
                expect(isValidCsrfToken(TOKEN, value)).toBe(false);
            });

            it.each([
                { name: '1 文字短い', value: TOKEN.slice(0, -1) },
                { name: '1 文字長い', value: `${TOKEN}x` },
                { name: '前半だけ', value: TOKEN.slice(0, 20) },
            ])('長さが違うトークン: $name', ({ value }) => {
                expect(isValidCsrfToken(TOKEN, value)).toBe(false);
            });

            it.each([
                { name: '前に空白', value: ` ${TOKEN}` },
                { name: '後ろに空白', value: `${TOKEN} ` },
                { name: '後ろに改行', value: `${TOKEN}\n` },
            ])('前後の空白は、取り除かない: $name', ({ value }) => {
                expect(isValidCsrfToken(TOKEN, value)).toBe(false);
            });

            it('文字数は同じでも、バイト数が違う物は、例外にならず false', () => {
                // 'é' は 1 文字で 2 バイト。文字数だけで長さを比べると、timingSafeEqual が例外を投げる
                expect(isValidCsrfToken('é', 'e')).toBe(false);
                expect(isValidCsrfToken('e', 'é')).toBe(false);
                expect(isValidCsrfToken('あ', 'a')).toBe(false);
                expect(isValidCsrfToken('a', 'あ')).toBe(false);
            });

            it('バイト数は同じでも、中身が違う物は false', () => {
                // 'é' は 2 バイト、'ab' も 2 バイト
                expect(isValidCsrfToken('é', 'ab')).toBe(false);
                expect(isValidCsrfToken('あいう', 'あいえ')).toBe(false);
            });

            it('空文字どうしでも、false(トークンが無いのに、通ってはいけない)', () => {
                expect(isValidCsrfToken('', '')).toBe(false);
            });

            it('片方だけ空文字でも、false', () => {
                expect(isValidCsrfToken(TOKEN, '')).toBe(false);
                expect(isValidCsrfToken('', TOKEN)).toBe(false);
            });

            it.each([undefined, null, 12345678, {}, [], true])(
                '期待する側が、文字列じゃない: %j',
                (value) => {
                    expect(isValidCsrfToken(value, TOKEN)).toBe(false);
                },
            );

            it.each([undefined, null, 12345678, {}, [], true])(
                '送られてきた側が、文字列じゃない: %j',
                (value) => {
                    expect(isValidCsrfToken(TOKEN, value)).toBe(false);
                },
            );

            it.each([undefined, null])(
                '両方とも無い(セッションにも、フォームにも無い)時は、false: %j',
                (value) => {
                    expect(isValidCsrfToken(value, value)).toBe(false);
                },
            );

            it('同じ配列どうしでも、false(文字列じゃないので)', () => {
                expect(isValidCsrfToken([TOKEN], [TOKEN])).toBe(false);
            });
            it.each([
                { name: '数値', value: 12345678 },
                { name: 'true', value: true },
                { name: '同じ配列(同じ物)', value: [TOKEN] },
                { name: '同じオブジェクト(同じ物)', value: { token: TOKEN } },
            ])(
                '両方が、同じ文字列じゃない物でも、false: $name',
                ({ value }) => {
                    expect(isValidCsrfToken(value, value)).toBe(false);
                },
            );
        });
    });

    describe('ensureCsrfToken', () => {
        it('無ければ、作って、セッションに入れて、返す', () => {
            const session: { csrfToken?: string } = {};

            const token = ensureCsrfToken(session);

            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(session.csrfToken).toBe(token);
        });

        it('あれば、そのまま返す(変えない)', () => {
            const session = { csrfToken: TOKEN };

            expect(ensureCsrfToken(session)).toBe(TOKEN);
            expect(session.csrfToken).toBe(TOKEN);
        });

        it('何回呼んでも、同じトークン', () => {
            const session: { csrfToken?: string } = {};

            const first = ensureCsrfToken(session);
            const second = ensureCsrfToken(session);
            const third = ensureCsrfToken(session);

            expect(second).toBe(first);
            expect(third).toBe(first);
        });

        it('空文字なら、作り直す', () => {
            const session = { csrfToken: '' };

            const token = ensureCsrfToken(session);

            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(session.csrfToken).toBe(token);
        });

        it('文字列じゃない物が入っていたら、作り直す', () => {
            const session = { csrfToken: 12345 as unknown as string };

            const token = ensureCsrfToken(session);

            expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
            expect(session.csrfToken).toBe(token);
        });

        it('セッションの、ほかの項目には触らない', () => {
            const session: { csrfToken?: string; userId: string } = {
                userId: 'user-1',
            };

            ensureCsrfToken(session);

            expect(session.userId).toBe('user-1');
        });

        it('別のセッションには、別のトークンができる', () => {
            const first = ensureCsrfToken({});
            const second = ensureCsrfToken({});

            expect(first).not.toBe(second);
        });
    });
});
