import { describe, expect, it } from 'vitest';
import type { Memo } from '../rs/memo-api.js';
import { sortNewestFirst } from './memo-sort.js';

const memo = (id: string, updatedAt: string): Memo => ({
    id,
    body: `body-${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
});

const idsOf = (memos: Memo[]) => memos.map((m) => m.id);

describe('MEMO SORT メモの一覧の並べ方', () => {
    describe('sortNewestFirst', () => {
        it('更新が新しい順に並べる', () => {
            const memos = [
                memo('old', '2026-11-01T00:00:00.000Z'),
                memo('new', '2026-11-03T00:00:00.000Z'),
                memo('mid', '2026-11-02T00:00:00.000Z'),
            ];

            expect(idsOf(sortNewestFirst(memos))).toEqual([
                'new',
                'mid',
                'old',
            ]);
        });

        it('すでに新しい順なら、そのまま', () => {
            const memos = [
                memo('a', '2026-11-03T00:00:00.000Z'),
                memo('b', '2026-11-02T00:00:00.000Z'),
                memo('c', '2026-11-01T00:00:00.000Z'),
            ];

            expect(idsOf(sortNewestFirst(memos))).toEqual(['a', 'b', 'c']);
        });

        it('古い順(RS が返す順)なら、ひっくり返る', () => {
            const memos = [
                memo('a', '2026-11-01T00:00:00.000Z'),
                memo('b', '2026-11-02T00:00:00.000Z'),
                memo('c', '2026-11-03T00:00:00.000Z'),
            ];

            expect(idsOf(sortNewestFirst(memos))).toEqual(['c', 'b', 'a']);
        });

        it('ミリ秒の違いも、見る', () => {
            const memos = [
                memo('a', '2026-11-01T00:00:00.001Z'),
                memo('b', '2026-11-01T00:00:00.002Z'),
                memo('c', '2026-11-01T00:00:00.000Z'),
            ];

            expect(idsOf(sortNewestFirst(memos))).toEqual(['b', 'a', 'c']);
        });

        it('日付は、文字の並びではなく、時刻として比べる(時差の表記が違っても)', () => {
            // 01:00+09:00 は、前日の 16:00Z。文字として比べると、逆になる
            const memos = [
                memo('tokyo', '2026-11-02T01:00:00.000+09:00'),
                memo('utc', '2026-11-01T20:00:00.000Z'),
            ];

            expect(idsOf(sortNewestFirst(memos))).toEqual(['utc', 'tokyo']);
        });

        describe('更新日時が同じ時', () => {
            it('元の並びで、後ろにある物(あとに作られた物)が先', () => {
                const same = '2026-11-01T00:00:00.000Z';
                const memos = [
                    memo('a', same),
                    memo('b', same),
                    memo('c', same),
                ];

                expect(idsOf(sortNewestFirst(memos))).toEqual(['c', 'b', 'a']);
            });

            it('同じ日時の物の間でだけ、元の並びの逆になる', () => {
                const same = '2026-11-02T00:00:00.000Z';
                const memos = [
                    memo('a', same),
                    memo('z-old', '2026-11-01T00:00:00.000Z'),
                    memo('b', same),
                    memo('y-new', '2026-11-03T00:00:00.000Z'),
                ];

                expect(idsOf(sortNewestFirst(memos))).toEqual([
                    'y-new',
                    'b',
                    'a',
                    'z-old',
                ]);
            });
        });

        describe('たくさんある時', () => {
            it('100 件でも、決まりの通りに並ぶ(新しい順。同じ時刻は、元の並びの後ろが先)', () => {
                // 時刻は、3 種類だけ(同じ時刻が、たくさんある)
                const times = [
                    '2026-11-01T00:00:00.000Z',
                    '2026-11-02T00:00:00.000Z',
                    '2026-11-03T00:00:00.000Z',
                ];
                const memos = Array.from({ length: 100 }, (_, i) =>
                    memo(`m${i}`, times[(i * 7) % 3] ?? times[0] ?? ''),
                );
                const expected = memos
                    .map((m, index) => ({ m, index }))
                    .sort(
                        (a, b) =>
                            Date.parse(b.m.updatedAt) -
                                Date.parse(a.m.updatedAt) || b.index - a.index,
                    )
                    .map(({ m }) => m.id);

                expect(idsOf(sortNewestFirst(memos))).toEqual(expected);
            });
        });

        describe('読めない日時', () => {
            it('いちばん古い物として、最後に置く', () => {
                const memos = [
                    memo('broken', 'yesterday'),
                    memo('ok', '2026-11-01T00:00:00.000Z'),
                ];

                expect(idsOf(sortNewestFirst(memos))).toEqual(['ok', 'broken']);
            });

            it('どんなに古い日付(1960 年)よりも、古い物として扱う', () => {
                const memos = [
                    memo('broken', 'yesterday'),
                    memo('very-old', '1960-01-01T00:00:00.000Z'),
                ];

                expect(idsOf(sortNewestFirst(memos))).toEqual([
                    'very-old',
                    'broken',
                ]);
            });

            it('読めない物どうしは、元の並びで後ろにある物が先', () => {
                const memos = [
                    memo('x', ''),
                    memo('ok', '2026-11-01T00:00:00.000Z'),
                    memo('y', 'nonsense'),
                ];

                expect(idsOf(sortNewestFirst(memos))).toEqual(['ok', 'y', 'x']);
            });
        });

        describe('返し方', () => {
            it('0 件なら、空', () => {
                expect(sortNewestFirst([])).toEqual([]);
            });

            it('1 件なら、そのまま', () => {
                const memos = [memo('a', '2026-11-01T00:00:00.000Z')];

                expect(idsOf(sortNewestFirst(memos))).toEqual(['a']);
            });

            it('新しい配列を返す。メモは、元と同じ物(コピーではない)', () => {
                const memos = [
                    memo('a', '2026-11-01T00:00:00.000Z'),
                    memo('b', '2026-11-02T00:00:00.000Z'),
                ];

                const sorted = sortNewestFirst(memos);

                expect(sorted).not.toBe(memos);
                expect(sorted[0]).toBe(memos[1]);
                expect(sorted[1]).toBe(memos[0]);
            });

            it('元の配列も、メモも、書き換えない', () => {
                const memos = Object.freeze([
                    Object.freeze(memo('a', '2026-11-01T00:00:00.000Z')),
                    Object.freeze(memo('b', '2026-11-02T00:00:00.000Z')),
                ]);

                expect(() => sortNewestFirst(memos)).not.toThrow();
                expect(idsOf([...memos])).toEqual(['a', 'b']);
            });
        });
    });
});
