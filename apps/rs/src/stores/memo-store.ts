/**
 * メモのストアの約束(docs/spec/simple-memo.md のデータモデル)
 *   今はメモリ(memory-memo-store.ts)。C6 で SQLite にする時も、この約束を守る
 */
export type Memo = {
    id: string;
    // 持ち主(アクセストークンの sub)
    owner: string;
    body: string;
    // 作成日時、更新日時(ISO 8601、UTC。例: 2030-01-01T00:00:00.000Z)
    createdAt: string;
    updatedAt: string;
};

export type NewMemo = {
    owner: string;
    body: string;
};

export interface MemoStore {
    // メモを作る。id と日時は、ストアが決める。同じ id が既にあれば、上書きせずにエラー
    create(input: NewMemo): Promise<Memo>;
    // id で探す。無ければ null(持ち主は、見ない)
    find(id: string): Promise<Memo | null>;
    // 持ち主のメモを、作った順(古い順)に、全部返す
    listByOwner(owner: string): Promise<Memo[]>;
    // 本文を書き換えて、更新日時を今にする。無ければ null
    update(id: string, body: string): Promise<Memo | null>;
    // 消す。消したら true、無ければ false
    delete(id: string): Promise<boolean>;
}
