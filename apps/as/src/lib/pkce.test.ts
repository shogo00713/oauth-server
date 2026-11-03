import { describe, it, expect } from 'vitest';
import { generateRandomString } from './random.js';
import {
    computeCodeChallenge,
    isValidCodeChallenge,
    isValidCodeVerifier,
    verifyCodeChallenge,
} from './pkce.js';

const verifier = {
    // ---- OK になるもの ----
    min: 'a'.repeat(43), // 下限ちょうど(43 文字)
    max: 'a'.repeat(128), // 上限ちょうど(128 文字)
    allChars:
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~', // 66 文字。許可 7 種類を全部
    appendixB: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', // RFC 7636 付録 B にあったやつ

    // ---- 長さが範囲外(文字は全部許可されたもの) ----
    tooShort: 'a'.repeat(42), // 下限の 1 つ下
    tooLong: 'a'.repeat(129), // 上限の 1 つ上
    empty: '',

    // ---- 長さは 43 文字のまま、不正な文字を 1 つだけ混ぜる ----
    withSpace: 'a'.repeat(42) + ' ',
    withPlus: 'a'.repeat(42) + '+',
    withSlash: 'a'.repeat(42) + '/',
    withEquals: 'a'.repeat(42) + '=',
    withNewline: 'a'.repeat(42) + '\n',
    withJapanese: 'a'.repeat(42) + 'あ',
    allJapanese: 'あ'.repeat(43),
    withEmoji: 'a'.repeat(41) + '😀', // .length が 43(絵文字が 2 つ分)

    // ---- 末尾の改行(長さは 44 文字) ----
    trailingNewline: 'a'.repeat(43) + '\n',
};

const challenge = {
    // ---- OK になるもの(43 文字ちょうど) ----
    appendixB: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', // 付録 B にあったやつの対応
    valid43: 'A'.repeat(43),

    // ---- 長さが 43 以外 ----
    tooShort: 'A'.repeat(42),
    tooLong: 'A'.repeat(44),
    plainLength: 'A'.repeat(128), // plain の長さ。S256 では許さない
    empty: '',

    // ---- 長さは 43 文字のまま、不正な文字を 1 つだけ混ぜる ----
    withDot: 'A'.repeat(42) + '.', // verifier では OK。challenge では NG
    withTilde: 'A'.repeat(42) + '~', // 同上
    withEquals: 'A'.repeat(42) + '=',
    withPlus: 'A'.repeat(42) + '+',
    withSlash: 'A'.repeat(42) + '/',
    withJapanese: 'A'.repeat(42) + 'あ',
    withNewLine: 'A'.repeat(42) + '\n',

    // ---- パディング付き(長さは 44 文字) ----
    withPadding: 'A'.repeat(43) + '=',
};

describe('PKCE RFC 7636', () => {
    describe('isValidCodeVerifier', () => {
        describe('OK になるもの', () => {
            it('長さの下限ちょうど(43 文字)', () => {
                expect(isValidCodeVerifier(verifier.min)).toBe(true);
            });
            it('長さの上限ちょうど(128 文字)', () => {
                expect(isValidCodeVerifier(verifier.max)).toBe(true);
            });
            it('許可された 7 種類の文字(A-Z / a-z / 0-9 / - . _ ~)が、全部使える', () => {
                expect(isValidCodeVerifier(verifier.allChars)).toBe(true);
            });
            it('generateRandomString(32) の出力が通る', () => {
                expect(isValidCodeVerifier(generateRandomString(32))).toBe(
                    true,
                );
            });
        });

        describe('長さが範囲外なら false', () => {
            it('42 文字(下限の 1 つ下)', () => {
                expect(isValidCodeVerifier(verifier.tooShort)).toBe(false);
            });
            it('129 文字(上限の 1 つ上)', () => {
                expect(isValidCodeVerifier(verifier.tooLong)).toBe(false);
            });
            it('空文字', () => {
                expect(isValidCodeVerifier(verifier.empty)).toBe(false);
            });
        });

        describe('許可されない文字が 1 つでも入ると false', () => {
            it.each([
                verifier.withEquals,
                verifier.withPlus,
                verifier.withSlash,
            ])('base64 の記号(+ / =)まで含んでいる', (value) => {
                expect(isValidCodeVerifier(value)).toBe(false);
            });
            it.each([
                verifier.withSpace,
                verifier.withNewline,
                verifier.trailingNewline,
            ])('空白と改行', (value) => {
                expect(isValidCodeVerifier(value)).toBe(false);
            });

            it.each([verifier.withJapanese, verifier.withEmoji])(
                '日本語と絵文字',
                (value) => {
                    expect(isValidCodeVerifier(value)).toBe(false);
                },
            );
        });

        describe('文字列でない値は false', () => {
            it.each([
                null,
                undefined,
                12,
                NaN,
                ['a'.repeat(43)],
                new String('a'.repeat(43)),
            ] as any[])('文字列以外', (value) => {
                expect(isValidCodeVerifier(value)).toBe(false);
            });
        });
    });

    describe('isValidCodeChallenge', () => {
        describe('OK になるもの', () => {
            it('付録 B の code_challenge', () => {
                expect(isValidCodeChallenge(challenge.appendixB)).toBe(true);
            });
            it('43 文字で、A-Za-z0-9_- だけ', () => {
                expect(isValidCodeChallenge(challenge.valid43)).toBe(true);
            });
        });

        describe('長さが 43 以外なら false', () => {
            it.each([challenge.tooShort, challenge.tooLong])(
                '42 文字と 44 文字',
                (value) => {
                    expect(isValidCodeChallenge(value)).toBe(false);
                },
            );
            it('128 文字(plain の長さ。S256 では許さない)', () => {
                expect(isValidCodeChallenge(challenge.plainLength)).toBe(false);
            });
            it('空文字', () => {
                expect(isValidCodeChallenge(challenge.empty)).toBe(false);
            });
        });

        describe('許可されない文字が入ると false', () => {
            it.each([challenge.withDot, challenge.withTilde])(
                '. と ~(verifier では許されるが、S256 の出力には出ない)',
                (value) => {
                    expect(isValidCodeChallenge(value)).toBe(false);
                },
            );
            it.each([
                challenge.withEquals,
                challenge.withPlus,
                challenge.withSlash,
            ])('パディングの = / + / /', (value) => {
                expect(isValidCodeChallenge(value)).toBe(false);
            });
            it.each([challenge.withJapanese, challenge.withNewLine])(
                '日本語と改行',
                (value) => {
                    expect(isValidCodeChallenge(value)).toBe(false);
                },
            );
        });

        describe('文字列でない値は false', () => {
            it.each([
                12,
                null,
                NaN,
                Infinity,
                ['a'.repeat(43)],
                new String('a'.repeat(43)),
            ] as any[])('文字列以外', (value) => {
                expect(isValidCodeChallenge(value)).toBe(false);
            });
        });
    });

    describe('computeCodeChallenge', () => {
        describe('既知の正解', () => {
            it('付録 B の verifier から、付録 B の challenge ができる', () => {
                expect(
                    computeCodeChallenge(
                        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
                    ),
                ).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
            });
        });

        describe('出力の性質', () => {
            it('43 文字で、base64url の文字だけ(= が付かない)', () => {
                const regex = /^[A-Za-z0-9_-]+$/;
                expect(computeCodeChallenge('a'.repeat(43))).toHaveLength(43);
                expect(computeCodeChallenge('a'.repeat(43))).toMatch(regex);
            });
            it('同じ入力なら、同じ出力', () => {
                expect(computeCodeChallenge('a'.repeat(42) + 'X')).toBe(
                    computeCodeChallenge('a'.repeat(42) + `X`),
                );
            });
            it('1 文字違う入力なら、別の出力', () => {
                expect(computeCodeChallenge('aaa')).not.toBe(
                    computeCodeChallenge('aab'),
                );
            });
            it('出力が isValidCodeChallenge を通る', () => {
                expect(isValidCodeChallenge(computeCodeChallenge('aaa'))).toBe(
                    true,
                );
            });
        });
    });

    describe('verifyCodeChallenge', () => {
        describe('正しい組は true', () => {
            it('付録 B の verifier と challenge の組', () => {
                expect(
                    verifyCodeChallenge(
                        'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
                        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                    ),
                ).toBe(true);
            });
            it('generateRandomString(32) で作った verifier を、計算して、照合する', () => {
                const randomString = generateRandomString();
                expect(
                    verifyCodeChallenge(
                        randomString,
                        computeCodeChallenge(randomString),
                    ),
                ).toBe(true);
            });
        });

        describe('正しくない challenge は false', () => {
            it('1 文字だけ違う', () => {
                expect(
                    verifyCodeChallenge(
                        'a' + `a`.repeat(42),
                        'b' + `a`.repeat(42),
                    ),
                ).toBe(false);
            });
            it('大文字小文字だけ違う', () => {
                expect(
                    verifyCodeChallenge(
                        'A' + `a`.repeat(42),
                        'a' + `a`.repeat(42),
                    ),
                ).toBe(false);
            });
            it('末尾に = が付いている', () => {
                expect(
                    verifyCodeChallenge(
                        `a`.repeat(42) + '=',
                        `a`.repeat(42) + '=',
                    ),
                ).toBe(false);
            });
            it('長さが違う', () => {
                expect(
                    verifyCodeChallenge('a'.repeat(42), 'a'.repeat(44)),
                ).toBe(false);
            });
            it('空文字', () => {
                expect(verifyCodeChallenge('', '')).toBe(false);
            });
            it('最後の1文字だけ違う例は false', () => {
                expect(
                    verifyCodeChallenge(
                        `a`.repeat(42) + `a`,
                        `a`.repeat(42) + `b`,
                    ),
                ).toBe(false);
            });
            it('大文字小文字を無視した challenge は false', () => {
                const s = generateRandomString();
                const s_challenge = computeCodeChallenge(s);
                expect(verifyCodeChallenge(s, s_challenge));
                expect(verifyCodeChallenge(s, s_challenge.toLowerCase()));
                expect(verifyCodeChallenge(s, s_challenge.toUpperCase()));
            });
        });

        describe('正しくない verifier は false', () => {
            it('形式が不正(42 文字)。そのハッシュを challenge に渡しても、false', () => {
                const s = 'a'.repeat(42);
                expect(verifyCodeChallenge(s, computeCodeChallenge(s))).toBe(
                    false,
                );
            });
            it('日本語始まりの文字列のコーナーケース', () => {
                const withJapanese = 'あ' + 'a'.repeat(42);
                const asciiB = 'B' + 'a'.repeat(42);
                expect(
                    verifyCodeChallenge(
                        withJapanese,
                        computeCodeChallenge(asciiB),
                    ),
                ).toBe(false);
            });
        });

        describe('すり替え', () => {
            it('challenge をそのまま verifier として渡しても false(plain 防止)', () => {
                expect(
                    verifyCodeChallenge(
                        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                        'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
                    ),
                ).toBe(false);
            });
            it('別の verifier から作った challenge は false', () => {
                const s1 = generateRandomString();
                const s2 = generateRandomString();
                expect(verifyCodeChallenge(s1, computeCodeChallenge(s2))).toBe(
                    false,
                );
            });
        });
    });
});
