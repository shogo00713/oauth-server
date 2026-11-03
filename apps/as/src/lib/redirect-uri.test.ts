import { describe, it, expect } from 'vitest';
import {
    haveSameRedirectUri,
    isValidRedirectUriFormat,
} from './redirect-uri.js';

const registered = ['http://a.example/cb', 'http://b.example/cb'];

describe('redirect-uri RFC 6749', () => {
    describe(`isValidRedirectUriFormat`, () => {
        it.each([
            {
                name: '基本OK',
                value: 'http://memoboard.localhost:4001/callback',
            },
            { name: '基本OK2', value: 'https://a.example/cb' },
            { name: 'ポート付き', value: 'http://a.example:4001/cb' },
            { name: 'クエリ付き', value: 'https://a.example/cb?x=1' },
            { name: '%はOK', value: 'http://a.example/%63b' },
            { name: '[]はOK', value: 'http://[::1]:4001/cb' },
            { name: '-とかOK', value: 'https://a.example/a-b_c.d~e' },
        ])('true: $name', ({ value }) => {
            expect(isValidRedirectUriFormat(value)).toBe(true);
        });

        it.each([
            { name: 'バックスラッシュ', value: 'http:\\a.example/cb' },
            { name: '//なし', value: 'http:a.example/cb' },
            { name: '非ASCII文字', value: 'http://あ.examle/cb' },
            { name: '非ASCII文字', value: 'http://a.examle/コールバック' },
            { name: '空文字', value: '' },
            { name: '相対URL', value: '/cb' },
            { name: 'スキーム違い1', value: 'data://a.example/cb' },
            { name: 'スキーム違い2', value: 'javascript:alert(1)' },
            { name: 'スキーム違い3', value: 'ftp://a.example/cb' },
            { name: 'ワイルドカード', value: 'https://*.example.com/cb' },
            { name: 'フラグメント持ち', value: 'http://a.example/cb#top' },
            { name: 'userinfo', value: 'http://u:p@a.example/cb' },
            { name: '文字列じゃない1', value: 1234 },
            { name: '文字列じゃない2', value: null },
            { name: '文字列じゃない3', value: ['http://a.example/cb'] },
            {
                name: '文字列じゃない4',
                value: new String('http://a.example/cb'),
            },
            { name: '空フラグメント', value: 'http://a.example/cb#' },
            { name: 'ホストなし', value: 'http://' },
            { name: 'ポートデカすぎ', value: 'http://a.example:99999/cb' },
            { name: 'passwordだけ', value: 'http://:p@a.example/cb' },
        ])('false: $name', ({ value }) => {
            expect(isValidRedirectUriFormat(value)).toBe(false);
        });
    });

    describe('haveSameRedirectUri', () => {
        it('正しい例', () => {
            expect(haveSameRedirectUri(registered[0], registered)).toBe(true);
            expect(haveSameRedirectUri(registered[1], registered)).toBe(true);
        });
        it.each([
            { name: '末尾に /', value: 'http://a.example/cb/' },
            { name: 'クエリ付き', value: 'http://a.example/cb?x=1' },
            { name: '前方一致だけ', value: 'http://a.example' },
            { name: '大文字小文字違い', value: 'http://A.Example/cb' },
            { name: 'スキーム違い', value: 'https://a.example/cb' },
            { name: '文字列じゃない', value: 12 },
            { name: 'エンコードの違い', value: 'http://a.example/%63b' },

            {
                name: '悪意ある書き方',
                value: 'http://a.example@evil.example/cb',
            },
        ])('false になる: $name', ({ value }) => {
            expect(haveSameRedirectUri(value, registered)).toBe(false);
        });
        it('空の登録リストでは false', () => {
            expect(haveSameRedirectUri('http://a.example/cb', [])).toBe(false);
        });
        it('登録リスト以外では false', () => {
            expect(haveSameRedirectUri('http://a.example/cb', 'happy')).toBe(
                false,
            );
        });
    });
});
