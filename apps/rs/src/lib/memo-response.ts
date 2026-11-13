/**
 * API の返事に載せる、メモの形(docs/design/rs.md: { id, body, createdAt, updatedAt })
 *   持ち主(owner)は、載せない
 */
import type { Memo } from '../stores/memo-store.js';

export type MemoResponse = {
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
};

// 決まった 4 つの項目だけを、取り出す(Memo に項目が増えても、勝手に外へ出ない)
export function toMemoResponse(memo: Memo): MemoResponse {
    return {
        id: memo.id,
        body: memo.body,
        createdAt: memo.createdAt,
        updatedAt: memo.updatedAt,
    };
}
