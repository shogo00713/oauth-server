import { describe, it, expect } from 'vitest';
import { decodeFormUrlencoded, parseClientCredentials } from './client-auth.js';

const basic = (credentials: string, scheme = 'Basic') =>
    `${scheme} ${Buffer.from(credentials, 'utf8').toString('base64')}`;

describe('CLIENT AUTH RFC 6749 2.3.1 / RFC 7617', () => {
    describe('decodeFormUrlencoded', () => {
        describe('デコードできる例', () => {
            it.each(['abc', ''])(
                '普通の文字列は、そのまま返る: %j',
                (value) => {
                    expect(decodeFormUrlencoded(value)).toBe(value);
                },
            );

            it('%20 は、空白になる', () => {
                expect(decodeFormUrlencoded('a%20b')).toBe('a b');
            });

            it('+ は、空白になる', () => {
                expect(decodeFormUrlencoded('a+b')).toBe('a b');
            });

            it('%2B は、+ になる', () => {
                expect(decodeFormUrlencoded('a%2Bb')).toBe('a+b');
            });

            it('%3A は、: になる', () => {
                expect(decodeFormUrlencoded('a%3Ab')).toBe('a:b');
            });

            it.each(['%E3%81%82', '%e3%81%82'])(
                '日本語も戻る。16 進が小文字でも、OK: %s',
                (value) => {
                    expect(decodeFormUrlencoded(value)).toBe('あ');
                },
            );

            it('二重にデコードしない(%2541 は、%41 になる)', () => {
                expect(decodeFormUrlencoded('%2541')).toBe('%41');
            });

            it('RFC 6749 付録 B の値', () => {
                expect(decodeFormUrlencoded('+%25%26%2B%C2%A3%E2%82%AC')).toBe(
                    ' %&+£€',
                );
            });
        });

        describe('null が返る場合', () => {
            it.each(['%', '%2', '%zz'])('壊れた %: %s', (value) => {
                expect(decodeFormUrlencoded(value)).toBeNull();
            });

            it.each(['%FF', '%C3'])('不正な UTF-8: %s', (value) => {
                expect(decodeFormUrlencoded(value)).toBeNull();
            });

            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: ['abc'] },
                { name: 'String オブジェクト', value: new String('abc') },
            ])('文字列以外の値: $name', ({ value }) => {
                expect(decodeFormUrlencoded(value)).toBeNull();
            });
        });
    });

    describe('parseClientCredentials', () => {
        describe('分解できる例', () => {
            it('RFC 7617 の例(Aladdin / open sesame)', () => {
                expect(
                    parseClientCredentials(
                        'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
                    ),
                ).toEqual({ clientId: 'Aladdin', clientSecret: 'open sesame' });
            });

            it('生成した値によくある文字(- と _)', () => {
                expect(parseClientCredentials(basic('id_-1:sec-_ret'))).toEqual(
                    { clientId: 'id_-1', clientSecret: 'sec-_ret' },
                );
            });

            it.each(['basic', 'BASIC'])(
                'スキーム名は、大文字小文字を区別しない: %s',
                (scheme) => {
                    expect(
                        parseClientCredentials(basic('a:b', scheme)),
                    ).toEqual({ clientId: 'a', clientSecret: 'b' });
                },
            );

            it('secret に : を含んでいても、最初の : で分かれる', () => {
                expect(parseClientCredentials(basic('id:pa:ss'))).toEqual({
                    clientId: 'id',
                    clientSecret: 'pa:ss',
                });
            });

            it('URL エンコードされた値は、デコードされる(%3A、+)', () => {
                expect(
                    parseClientCredentials(basic('client%3Aid:a+b')),
                ).toEqual({ clientId: 'client:id', clientSecret: 'a b' });
            });

            it('二重にデコードしない(%2541 は、%41)', () => {
                expect(parseClientCredentials(basic('id:%2541'))).toEqual({
                    clientId: 'id',
                    clientSecret: '%41',
                });
            });

            it('RFC 6749 付録 B の値', () => {
                expect(
                    parseClientCredentials(
                        basic('id:+%25%26%2B%C2%A3%E2%82%AC'),
                    ),
                ).toEqual({ clientId: 'id', clientSecret: ' %&+£€' });
            });

            it('生の UTF-8(日本語)も、通る', () => {
                expect(parseClientCredentials(basic('あ:ぱ'))).toEqual({
                    clientId: 'あ',
                    clientSecret: 'ぱ',
                });
            });
            it.each([
                { header: 'Basic aWQ6ISE+', secret: '!!>' },
                { header: 'Basic aWQ6ISE/', secret: '!!?' },
            ])(
                'Base64 の標準の文字(+ と /)も、通る: $header',
                ({ header, secret }) => {
                    expect(parseClientCredentials(header)).toEqual({
                        clientId: 'id',
                        clientSecret: secret,
                    });
                },
            );
        });

        describe('null が返る場合', () => {
            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: [basic('a:b')] },
                {
                    name: 'String オブジェクト',
                    value: new String(basic('a:b')),
                },
            ])('文字列以外の値: $name', ({ value }) => {
                expect(parseClientCredentials(value)).toBeNull();
            });

            it.each(['', 'Basic', 'Basic '])(
                '空文字、スキームだけ、スキームと空白だけ: %j',
                (value) => {
                    expect(parseClientCredentials(value)).toBeNull();
                },
            );

            it.each(['Bearer', 'Digest'])(
                'Basic 以外のスキーム: %s',
                (scheme) => {
                    expect(
                        parseClientCredentials(basic('a:b', scheme)),
                    ).toBeNull();
                },
            );

            it('スキームと Base64 の間に、空白がない', () => {
                expect(
                    parseClientCredentials(
                        basic('a:b').replace('Basic ', 'Basic'),
                    ),
                ).toBeNull();
            });

            it.each([
                { name: '先頭に空白', value: ` ${basic('a:b')}` },
                { name: '末尾に空白', value: `${basic('a:b')} ` },
            ])('前後に空白がある: $name', ({ value }) => {
                expect(parseClientCredentials(value)).toBeNull();
            });

            it.each([
                {
                    name: 'パディングなし',
                    value: 'Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ',
                },
                { name: 'url-safe 文字', value: 'Basic aWQ6ISE-' },
                {
                    name: 'ゴミ文字',
                    value: 'Basic QWxhZGRpbjpvcGVu!!IHNlc2FtZQ==',
                },
                {
                    name: '途中に空白',
                    value: 'Basic QWxhZGRp bjpvcGVuIHNlc2FtZQ==',
                },
                {
                    name: '途中に改行',
                    value: 'Basic QWxhZGRpbjpv\ncGVuIHNlc2FtZQ==',
                },
            ])('Base64 が壊れている: $name', ({ value }) => {
                expect(parseClientCredentials(value)).toBeNull();
            });

            it('コロンがない', () => {
                expect(parseClientCredentials(basic('onlyid'))).toBeNull();
            });

            it.each([':secret', 'id:', ':'])(
                'client_id か secret が空: %j',
                (credentials) => {
                    expect(
                        parseClientCredentials(basic(credentials)),
                    ).toBeNull();
                },
            );

            it.each([
                { name: '生の改行', value: basic('id\n:secret') },
                { name: 'デコード後の改行', value: basic('a%0Ab:secret') },
            ])('制御文字を含む: $name', ({ value }) => {
                expect(parseClientCredentials(value)).toBeNull();
            });

            it.each([
                { name: 'client_id 側', value: basic('id%zz:secret') },
                { name: 'secret 側', value: basic('id:%') },
            ])('壊れた % を含む: $name', ({ value }) => {
                expect(parseClientCredentials(value)).toBeNull();
            });

            it.each([
                { name: '%FF', value: basic('id:%FF') },
                {
                    name: 'Base64 の中身',
                    value:
                        'Basic ' +
                        Buffer.from([0x61, 0xff, 0x3a, 0x62]).toString(
                            'base64',
                        ),
                },
            ])('不正な UTF-8: $name', ({ value }) => {
                expect(parseClientCredentials(value)).toBeNull();
            });
        });
    });
});
