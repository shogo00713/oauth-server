import { describe, it, expect } from 'vitest';
import { hasAnyScope, parseScope } from './scope.js';

describe('SCOPE RS のスコープ RFC 6749 3.3', () => {
    describe('parseScope', () => {
        describe('正しい例', () => {
            it('read を 1 つ渡すと、配列で返る', () => {
                expect(parseScope('read')).toEqual(['read']);
            });

            it.each(['read write', 'write read'])(
                'read と write を渡すと、並び替えた配列になる: %s',
                (value) => {
                    expect(parseScope(value)).toEqual(['read', 'write']);
                },
            );

            it('重複は、1 つにまとまる', () => {
                expect(parseScope('read write read')).toEqual([
                    'read',
                    'write',
                ]);
            });

            it.each(['a:b', 'https://example.com/scope', 'read.memo'])(
                '変なスコープの値は、1 つのトークンとして配列になる: %s',
                (value) => {
                    expect(parseScope(value)).toEqual([value]);
                },
            );

            it.each(['a!b', 'a#b', 'a[b', 'a]b', 'a~b', 'a{b}', '!', '~'])(
                '使える記号(境目の文字を含む): %s',
                (value) => {
                    expect(parseScope(value)).toEqual([value]);
                },
            );

            it('カンマでは分割されない', () => {
                expect(parseScope('read,write')).toEqual(['read,write']);
            });

            it('大文字のスコープも、そのまま配列で返る', () => {
                expect(parseScope('READ')).toEqual(['READ']);
            });
        });

        describe('null が返る場合', () => {
            it('空文字', () => {
                expect(parseScope('')).toBeNull();
            });

            it('空白だけ', () => {
                expect(parseScope(' ')).toBeNull();
            });

            it.each([' read', 'read '])(
                '先頭か末尾に空白がある: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it.each(['read  write', 'read   write'])(
                'スコープの間に空白が 2 つ以上ある: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it.each(['read\twrite', 'read\nwrite', 'read\n'])(
                '制御文字 (タブ・改行) を含んでいる: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it.each(['re"ad', 're\\ad'])(
                'ダブルクォーテーションかバックスラッシュを使っている: %j',
                (value) => {
                    expect(parseScope(value)).toBeNull();
                },
            );

            it('ASCII 以外の文字を使っている', () => {
                expect(parseScope('読む')).toBeNull();
            });

            it('DEL(0x7F)を含んでいる', () => {
                expect(parseScope('read\u007f')).toBeNull();
            });

            it.each([
                { name: 'null', value: null },
                { name: 'undefined', value: undefined },
                { name: '数値', value: 12 },
                { name: '配列', value: ['read'] },
                { name: 'String オブジェクト', value: new String('read') },
            ])('文字列以外の値: $name', ({ value }) => {
                expect(parseScope(value)).toBeNull();
            });
        });
    });

    describe('hasAnyScope(トークンのスコープに、受け付けるスコープの、どれかが入っているか)', () => {
        describe('true になる場合', () => {
            it.each([
                {
                    name: 'GET: read だけ持っている',
                    granted: ['read'],
                    accepted: ['read', 'write'],
                },
                {
                    name: 'GET: write だけ持っている(write は read を含む)',
                    granted: ['write'],
                    accepted: ['read', 'write'],
                },
                {
                    name: 'POST などは write が要る: write を持っている',
                    granted: ['write'],
                    accepted: ['write'],
                },
                {
                    name: '両方持っていて、write が要る',
                    granted: ['read', 'write'],
                    accepted: ['write'],
                },
                {
                    name: '余計なスコープを持っていても、良い',
                    granted: ['admin', 'read'],
                    accepted: ['read'],
                },
                {
                    name: '受け付ける物に、重複があっても、良い',
                    granted: ['read'],
                    accepted: ['read', 'read'],
                },
            ])('$name', ({ granted, accepted }) => {
                expect(hasAnyScope(granted, accepted)).toBe(true);
            });
        });

        describe('false になる場合', () => {
            it.each([
                {
                    name: 'write が要るのに、read だけ',
                    granted: ['read'],
                    accepted: ['write'],
                },
                {
                    name: '関係ないスコープだけ',
                    granted: ['admin'],
                    accepted: ['read', 'write'],
                },
                {
                    name: '大文字小文字が違う',
                    granted: ['READ'],
                    accepted: ['read'],
                },
                {
                    name: 'トークンのスコープの方が、前方一致で短い',
                    granted: ['rea'],
                    accepted: ['read'],
                },
                {
                    name: 'トークンのスコープの方が、前方一致で長い',
                    granted: ['readx'],
                    accepted: ['read'],
                },
                {
                    name: 'トークンのスコープが、空',
                    granted: [],
                    accepted: ['read', 'write'],
                },
                {
                    name: '受け付けるスコープが、空(誰も通さない)',
                    granted: ['read', 'write'],
                    accepted: [],
                },
                {
                    name: '両方空',
                    granted: [],
                    accepted: [],
                },
            ])('$name', ({ granted, accepted }) => {
                expect(hasAnyScope(granted, accepted)).toBe(false);
            });
        });

        it('渡した配列は、書き換えない', () => {
            const granted = ['write', 'read'];
            const accepted = ['write'];

            hasAnyScope(granted, accepted);

            expect(granted).toEqual(['write', 'read']);
            expect(accepted).toEqual(['write']);
        });
    });
});
