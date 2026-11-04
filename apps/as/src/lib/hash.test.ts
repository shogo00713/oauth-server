import { describe, it, expect } from 'vitest';
import { generateRandomString } from './random.js';
import { sha256Hex, verifySecret } from './hash.js';

const hashOfAbc =
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const hashOfEmpty =
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('HASH SHA-256', () => {
    describe('sha256Hex', () => {
        describe('既知の答え', () => {
            it.each([
                { name: '空文字', input: '', expected: hashOfEmpty },
                { name: 'abc', input: 'abc', expected: hashOfAbc },
                {
                    name: 'NIST の長い例',
                    input: 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
                    expected:
                        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
                },
                {
                    name: '日本語(UTF-8)',
                    input: 'あ',
                    expected:
                        'dc5a4d3d82f7e15792959dc661538ae0e541ce66494516f5c9cfd9cd3308494d',
                },
                {
                    name: '末尾の改行も、値の一部',
                    input: 'abc\n',
                    expected:
                        'edeaaff3f1774ad2888673770c6d64097e391bc362d7d6fb34982ddf0efd18cb',
                },
            ])('既知の答えと一致する: $name', ({ input, expected }) => {
                expect(sha256Hex(input)).toBe(expected);
            });
        });

        describe('出力の性質', () => {
            it('64 文字の小文字の 16 進になる', () => {
                expect(sha256Hex(generateRandomString())).toMatch(
                    /^[0-9a-f]{64}$/,
                );
            });

            it('同じ入力なら、同じ出力', () => {
                expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
            });

            it.each([
                { name: '大文字小文字', a: 'abc', b: 'ABC' },
                { name: '末尾の空白', a: 'abc', b: 'abc ' },
                { name: '先頭の空白', a: 'abc', b: ' abc' },
            ])('違う入力なら、違う出力: $name', ({ a, b }) => {
                expect(sha256Hex(a)).not.toBe(sha256Hex(b));
            });
        });

        describe('文字列以外は TypeError', () => {
            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: ['abc'] },
                { name: 'String オブジェクト', value: new String('abc') },
            ])('$name', ({ value }) => {
                expect(() => sha256Hex(value as any)).toThrow(TypeError);
            });
        });
    });

    describe('verifySecret', () => {
        describe('true になる場合', () => {
            it('sha256Hex で作ったハッシュと、元の secret の組', () => {
                const secret = generateRandomString();
                expect(verifySecret(secret, sha256Hex(secret))).toBe(true);
            });

            it('既知の組(abc と、そのハッシュ)', () => {
                expect(verifySecret('abc', hashOfAbc)).toBe(true);
            });
        });

        describe('false になる場合', () => {
            it.each(['abd', 'ABC', 'abc ', 'abc\n', ' abc'])(
                '違う secret: %j',
                (secret) => {
                    expect(verifySecret(secret, hashOfAbc)).toBe(false);
                },
            );

            it('空の secret は、空文字のハッシュと一致しても、false', () => {
                expect(verifySecret('', hashOfEmpty)).toBe(false);
            });

            it.each([
                { name: '大文字の 16 進', hash: hashOfAbc.toUpperCase() },
                { name: '63 文字', hash: hashOfAbc.slice(0, 63) },
                { name: '65 文字', hash: `${hashOfAbc}0` },
                { name: '空文字', hash: '' },
                { name: '16 進ではない 64 文字', hash: 'z'.repeat(64) },
                { name: 'プレフィックス付き', hash: `sha256:${hashOfAbc}` },
                { name: '先頭に空白', hash: ` ${hashOfAbc}` },
                { name: '末尾に改行', hash: `${hashOfAbc}\n` },
            ])('保存済みのハッシュの形が変: $name', ({ hash }) => {
                expect(verifySecret('abc', hash)).toBe(false);
            });

            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: ['abc'] },
                { name: 'String オブジェクト', value: new String('abc') },
            ])('文字列以外の secret: $name', ({ value }) => {
                expect(verifySecret(value, hashOfAbc)).toBe(false);
            });

            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: [hashOfAbc] },
                { name: 'String オブジェクト', value: new String(hashOfAbc) },
            ])('文字列以外のハッシュ: $name', ({ value }) => {
                expect(verifySecret('abc', value)).toBe(false);
            });
        });
    });
});
