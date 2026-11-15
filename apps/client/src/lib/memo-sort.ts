/**
 * メモの一覧の並べ方(RS は、作った順で返してくる)
 */
import type { Memo } from '../rs/memo-api.js';

// 更新日時(ミリ秒)。読めない日時は、いちばん古い物として扱う
const timeOf = (memo: Memo): number => {
    const time = Date.parse(memo.updatedAt);
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};

/**
 * 更新が新しい順に並べた、新しい配列を返す
 *   更新日時が同じなら、元の並びで、後ろにある物(あとに作られた物)が先
 *   元の配列も、メモも、書き換えない
 */
export function sortNewestFirst(memos: readonly Memo[]): Memo[] {
    return memos
        .map((memo, index) => ({ memo, index, time: timeOf(memo) }))
        .sort((a, b) =>
            a.time === b.time ? b.index - a.index : a.time < b.time ? 1 : -1,
        )
        .map(({ memo }) => memo);
}
