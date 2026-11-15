import { describe, expect, it } from 'vitest';
import type { Memo } from '../rs/memo-api.js';
import { searchMemos } from './memo-search.js';

// 見た目では、区別しにくい文字。コードの中に直接書かずに、番号で作る
const IDEOGRAPHIC_SPACE = String.fromCodePoint(0x3000);
const COMBINING_DAKUTEN = String.fromCodePoint(0x3099);

const memo = (id: string, body: string): Memo => ({
    id,
    body,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-02T00:00:00.000Z',
});

const MEMOS: Memo[] = [
    memo('m1', '牛乳を買う'),
    memo('m2', 'Buy Milk and eggs'),
    memo('m3', 'レポートを書く\n締め切りは金曜'),
    memo('m4', 'ＭＩＬＫ ティー 123'),
    memo('m5', '正規表現: .* と ( と [ と \\ と + と ? と ^ と $'),
    memo('m6', 'ガーデニング 😀'),
];

const idsOf = (memos: Memo[]) => memos.map((m) => m.id);
const search = (query: string, memos: readonly Memo[] = MEMOS) =>
    idsOf(searchMemos(memos, query));

describe('MEMO SEARCH メモのキーワード検索', () => {
    describe('searchMemos', () => {
        describe('検索語が空', () => {
            it.each([
                { name: '空文字', query: '' },
                { name: '半角の空白', query: '   ' },
                {
                    name: '全角の空白',
                    query: `${IDEOGRAPHIC_SPACE}${IDEOGRAPHIC_SPACE}`,
                },
                { name: 'タブと改行', query: '\t\n' },
            ])('$name なら、全部を、元の順番で返す', ({ query }) => {
                expect(search(query)).toEqual([
                    'm1',
                    'm2',
                    'm3',
                    'm4',
                    'm5',
                    'm6',
                ]);
            });

            it('元の配列とは、別の配列を返す(返した配列を変えても、元は変わらない)', () => {
                const result = searchMemos(MEMOS, '');

                expect(result).not.toBe(MEMOS);
                result.pop();
                expect(MEMOS).toHaveLength(6);
            });

            it('メモが 0 件なら、空', () => {
                expect(search('', [])).toEqual([]);
                expect(search('牛乳', [])).toEqual([]);
            });
        });

        describe('1 つの語', () => {
            it('本文に入っていれば、見つかる(部分一致)', () => {
                expect(search('牛乳')).toEqual(['m1']);
                expect(search('乳を買')).toEqual(['m1']);
            });

            it('どこにも入っていなければ、空', () => {
                expect(search('みかん')).toEqual([]);
            });

            it('本文より長い語は、見つからない', () => {
                expect(search('牛乳を買う。そして、卵も買う')).toEqual([]);
            });

            it('絵文字も探せる', () => {
                expect(search('😀')).toEqual(['m6']);
            });

            it('語の前後の空白は、無視する', () => {
                expect(search('  牛乳  ')).toEqual(['m1']);
            });

            it('本文に改行があっても、その中の語を探せる', () => {
                expect(search('レポート')).toEqual(['m3']);
                expect(search('締め切り')).toEqual(['m3']);
            });
        });

        describe('大文字と小文字', () => {
            it.each(['milk', 'MILK', 'mIlK'])('区別しない: %s', (query) => {
                expect(search(query)).toEqual(['m2', 'm4']);
            });
        });

        describe('全角と半角(NFKC)', () => {
            it('全角の英字で探すと、半角の英字の本文も見つかる', () => {
                expect(search('ＢＵＹ')).toEqual(['m2']);
            });

            it('半角の英字で探すと、全角の英字の本文も見つかる(m4 は全角の MILK)', () => {
                expect(search('milk ティー')).toEqual(['m4']);
            });

            it('全角の数字と半角の数字', () => {
                expect(search('１２３')).toEqual(['m4']);
                expect(search('123')).toEqual(['m4']);
            });

            it('半角カナで探すと、全角カナの本文も見つかる(濁点・半濁点は、くっつく)', () => {
                expect(search('ﾚﾎﾟｰﾄ')).toEqual(['m3']);
                expect(search('ｶﾞｰﾃﾞﾆﾝｸﾞ')).toEqual(['m6']);
            });

            it('濁点が分解された形(カ + 濁点)で探しても、「ガ」と同じに探せる', () => {
                expect(search(`カ${COMBINING_DAKUTEN}ーデニング`)).toEqual([
                    'm6',
                ]);
            });

            it('本文の側が分解された形でも、見つかる', () => {
                const decomposed = [
                    memo('d1', `カ${COMBINING_DAKUTEN}ーデニング`),
                ];

                expect(search('ガーデニング', decomposed)).toEqual(['d1']);
            });
        });

        describe('複数の語(AND)', () => {
            it('全部の語が入っているメモだけが、残る', () => {
                expect(search('milk eggs')).toEqual(['m2']);
            });

            it('語の順番は、関係ない', () => {
                expect(search('eggs milk')).toEqual(['m2']);
            });

            it('1 つでも入っていなければ、残らない', () => {
                expect(search('milk 牛乳')).toEqual([]);
                expect(search('milk みかん')).toEqual([]);
            });

            it('語は、本文の別の行にあっても良い', () => {
                expect(search('レポート 金曜')).toEqual(['m3']);
            });

            it.each([
                { name: '半角の空白', query: 'milk eggs' },
                { name: '全角の空白', query: `milk${IDEOGRAPHIC_SPACE}eggs` },
                { name: 'タブ', query: 'milk\teggs' },
                { name: '改行', query: 'milk\neggs' },
                {
                    name: '連続した空白',
                    query: `milk   ${IDEOGRAPHIC_SPACE}  eggs`,
                },
                { name: '前後にも空白', query: '  milk eggs  ' },
            ])('語の区切りは、空白の種類を問わない: $name', ({ query }) => {
                expect(search(query)).toEqual(['m2']);
            });

            it('同じ語を重ねても、結果は同じ', () => {
                expect(search('milk milk milk')).toEqual(['m2', 'm4']);
            });
        });

        describe('正規表現の記号は、ただの文字', () => {
            it.each([
                { query: '.*', expected: ['m5'] },
                { query: '(', expected: ['m5'] },
                { query: '[', expected: ['m5'] },
                { query: '\\', expected: ['m5'] },
                { query: '+', expected: ['m5'] },
                { query: '?', expected: ['m5'] },
                { query: '^', expected: ['m5'] },
                { query: '$', expected: ['m5'] },
            ])(
                '$query で探しても、その文字を含むメモだけが残る',
                ({ query, expected }) => {
                    expect(search(query)).toEqual(expected);
                },
            );

            it('「.」は、任意の 1 文字ではない', () => {
                expect(search('m.lk')).toEqual([]);
            });
        });

        describe('探す場所と、返し方', () => {
            it('本文だけを探す(id や日時には、当たらない)', () => {
                expect(search('m1')).toEqual([]);
                expect(search('2026')).toEqual([]);
            });

            it('元の順番のまま返す', () => {
                expect(search('milk')).toEqual(['m2', 'm4']);
                const reversed = [...MEMOS].reverse();

                expect(search('milk', reversed)).toEqual(['m4', 'm2']);
            });

            it('返すメモは、元と同じ物(コピーではない)', () => {
                const [found] = searchMemos(MEMOS, '牛乳');

                expect(found).toBe(MEMOS[0]);
            });

            it('元の配列も、メモも、書き換えない', () => {
                const frozen = MEMOS.map((m) => Object.freeze({ ...m }));
                Object.freeze(frozen);

                expect(() => searchMemos(frozen, 'milk eggs')).not.toThrow();
                expect(() => searchMemos(frozen, '')).not.toThrow();
            });
        });
    });
});
