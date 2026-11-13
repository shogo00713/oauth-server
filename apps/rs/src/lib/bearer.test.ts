import { describe, it, expect } from 'vitest';
import { extractBearerToken } from './bearer.js';

const NONE = { kind: 'none' };
const MALFORMED = { kind: 'malformed' };
const token = (value: string) => ({ kind: 'token', token: value });

describe('BEARER Authorization ヘッダーの解析 RFC 6750 2.1 / RFC 9110 11.1', () => {
    describe('extractBearerToken', () => {
        describe('トークンが取り出せる例', () => {
            it('Bearer の後ろの、トークンが返る', () => {
                expect(extractBearerToken('Bearer mF_9.B5f-4.1JqM')).toEqual(
                    token('mF_9.B5f-4.1JqM'),
                );
            });

            it('JWT の形(ドット区切りの 3 つ)も、そのまま返る', () => {
                const jwt = [
                    'eyJhbGciOiJSUzI1NiJ9',
                    'eyJzdWIiOiJ1c2VyIn0',
                    'c2lnbmF0dXJl',
                ].join('.');

                expect(extractBearerToken(`Bearer ${jwt}`)).toEqual(token(jwt));
            });

            it.each([
                { name: '小文字', header: 'bearer abc' },
                { name: '大文字', header: 'BEARER abc' },
                { name: '大小まぜ', header: 'bEaReR abc' },
            ])(
                '方式の名前は、大文字小文字を区別しない: $name',
                ({ header }) => {
                    expect(extractBearerToken(header)).toEqual(token('abc'));
                },
            );

            it('トークンの大文字小文字は、そのまま(変えない)', () => {
                expect(extractBearerToken('Bearer AbCdEf')).toEqual(
                    token('AbCdEf'),
                );
            });

            it('方式の名前とトークンの間の空白は、1 個以上なら、いくつでも良い', () => {
                expect(extractBearerToken('Bearer   abc')).toEqual(
                    token('abc'),
                );
            });

            it.each([
                { name: '英数字', value: 'AZaz09' },
                { name: 'ハイフン、ドット、アンダースコア', value: 'a-b.c_d' },
                { name: 'チルダ、プラス、スラッシュ', value: 'a~b+c/d' },
                { name: '末尾の = (パディング)', value: 'YWJj=' },
                { name: '末尾の == (パディング)', value: 'YQ==' },
            ])('使える文字: $name', ({ value }) => {
                expect(extractBearerToken(`Bearer ${value}`)).toEqual(
                    token(value),
                );
            });
        });

        describe('認証情報が無い扱い(none): エラーにしない', () => {
            it('ヘッダーが無い', () => {
                expect(extractBearerToken(undefined)).toEqual(NONE);
            });

            it('空文字', () => {
                expect(extractBearerToken('')).toEqual(NONE);
            });

            it.each([
                { name: 'Basic', header: 'Basic dXNlcjpwYXNz' },
                { name: 'Digest', header: 'Digest username="a"' },
                { name: '知らない方式', header: 'Token abc' },
                { name: '方式の名前だけ(Basic)', header: 'Basic' },
                {
                    name: '方式の名前の前が Bearer と同じ',
                    header: 'BearerX abc',
                },
                {
                    name: '方式の名前の後ろが Bearer と同じ',
                    header: 'XBearer abc',
                },
                { name: 'Bearer が、トークンの側にある', header: 'abc Bearer' },
                { name: 'ハイフンで続く', header: 'Bearer-abc abc' },
            ])('Bearer 以外の方式: $name', ({ header }) => {
                expect(extractBearerToken(header)).toEqual(NONE);
            });
        });

        describe('Bearer なのに、形が正しくない(malformed)', () => {
            it.each([
                { name: 'トークンが無い(方式の名前だけ)', header: 'Bearer' },
                { name: 'トークンが無い(空白だけ)', header: 'Bearer ' },
                { name: 'トークンが無い(空白が複数)', header: 'Bearer    ' },
                { name: '小文字でも、トークンが無い', header: 'bearer' },
            ])('トークンが無い: $name', ({ header }) => {
                expect(extractBearerToken(header)).toEqual(MALFORMED);
            });

            it.each([
                { name: 'トークンが 2 つ', header: 'Bearer abc def' },
                { name: '途中に空白', header: 'Bearer ab cd' },
                { name: '末尾に空白で別の物', header: 'Bearer abc x' },
            ])('トークンの中に、空白: $name', ({ header }) => {
                expect(extractBearerToken(header)).toEqual(MALFORMED);
            });

            it.each([
                { name: 'ダブルクォート', header: 'Bearer "abc"' },
                { name: 'ドル記号', header: 'Bearer abc$' },
                { name: 'カンマ', header: 'Bearer abc,def' },
                { name: 'セミコロン', header: 'Bearer abc;def' },
                { name: 'バックスラッシュ', header: 'Bearer ab\\cd' },
                { name: '日本語', header: 'Bearer トークン' },
                { name: '全角の英字', header: 'Bearer ａｂｃ' },
            ])('使えない文字: $name', ({ header }) => {
                expect(extractBearerToken(header)).toEqual(MALFORMED);
            });

            it.each([
                { name: '= だけ', header: 'Bearer =' },
                { name: '= が複数だけ', header: 'Bearer ===' },
                { name: '= が途中', header: 'Bearer ab=cd' },
                { name: '= の後ろに文字', header: 'Bearer abc=d' },
                { name: '先頭が =', header: 'Bearer =abc' },
            ])('= の位置が正しくない: $name', ({ header }) => {
                expect(extractBearerToken(header)).toEqual(MALFORMED);
            });

            it.each([
                { name: '末尾の改行', header: 'Bearer abc\n' },
                { name: '末尾の CRLF', header: 'Bearer abc\r\n' },
                {
                    name: 'ヘッダーの注入のような形',
                    header: 'Bearer abc\r\nX-Injected: 1',
                },
            ])('改行を含む: $name', ({ header }) => {
                expect(extractBearerToken(header)).toEqual(MALFORMED);
            });
        });
    });
});
