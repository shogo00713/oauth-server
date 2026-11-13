import { randomUUID } from 'node:crypto';
import type { Memo, MemoStore } from './memo-store.js';

export type MemoryMemoStoreOptions = {
    // 今の時刻(ミリ秒。Date.now と同じ)を返す関数。テストで差し替えられる
    now?: (() => number) | undefined;
    // メモの id を作る関数。テストで差し替えられる
    generateId?: (() => string) | undefined;
};

export function createMemoryMemoStore(
    options: MemoryMemoStoreOptions = {},
): MemoStore {
    const now = options.now ?? Date.now;
    const generateId = options.generateId ?? randomUUID;
    // Map は、入れた順番を覚えている(一覧は、作った順に返す)
    const memos = new Map<string, Memo>();

    const timestamp = () => new Date(now()).toISOString();

    return {
        async create({ owner, body }) {
            const id = generateId();
            if (memos.has(id)) throw new Error('same memo id already exists!');

            const createdAt = timestamp();
            const memo: Memo = {
                id,
                owner,
                body,
                createdAt,
                updatedAt: createdAt,
            };
            memos.set(id, memo);
            return { ...memo };
        },

        async find(id) {
            const memo = memos.get(id);
            return memo ? { ...memo } : null;
        },

        async listByOwner(owner) {
            return [...memos.values()]
                .filter((memo) => memo.owner === owner)
                .map((memo) => ({ ...memo }));
        },

        async update(id, body) {
            const memo = memos.get(id);
            if (!memo) return null;

            // 既にある id に set しても、Map の中の順番は変わらない
            const updated: Memo = { ...memo, body, updatedAt: timestamp() };
            memos.set(id, updated);
            return { ...updated };
        },

        async delete(id) {
            return memos.delete(id);
        },
    };
}
