/**
 * メモのキーワード検索(client の中で、絞り込む。RS には、検索の API が無い)
 *   検索語は、空白で区切った「語」にして、全部の語が、本文に入っているメモだけを残す(AND)
 *   大文字と小文字、全角と半角の違いは、無視する(NFKC に直してから比べる)
 *   正規表現ではない。「.*」や「(」も、ただの文字として探す
 */
import type { Memo } from '../rs/memo-api.js';

// 比べる前に揃える: 全角英数や半角カナ、濁点の分解形を普通の形(NFKC)に直して、小文字にする
const normalize = (text: string): string =>
    text.normalize('NFKC').toLowerCase();

export function searchMemos(memos: readonly Memo[], query: string): Memo[] {
    const terms = normalize(query)
        .split(/\s+/u)
        .filter((term) => term !== '');
    // 検索語が空(空白だけも含む)なら、絞り込まない
    if (terms.length === 0) return [...memos];

    return memos.filter((memo) => {
        const body = normalize(memo.body);
        return terms.every((term) => body.includes(term));
    });
}
