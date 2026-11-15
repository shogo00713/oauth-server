import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';
import type { Memo, MemoStore } from './memo-store.js';

export type SqliteMemoStoreOptions = {
    // データベースのファイルの場所。':memory:' なら、メモリの上だけ(止めると、消える)
    path: string;
    // 今の時刻(ミリ秒。Date.now と同じ)を返す関数。テストで差し替えられる
    now?: (() => number) | undefined;
    // メモの id を作る関数。テストで差し替えられる
    generateId?: (() => string) | undefined;
};

export type SqliteMemoStore = MemoStore & {
    // データベースを閉じる(2 回呼んでも、良い)。閉じたあとは、使えない
    close(): void;
};

// docs/design/rs.md の、memos テーブル。STRICT: 列の型が違う物は、入れられない
const SCHEMA = `
    CREATE TABLE IF NOT EXISTS memos (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    ) STRICT
`;

const COLUMNS = 'id, owner, body, created_at, updated_at';

function toMemo(row: Record<string, SQLOutputValue>): Memo {
    const { id, owner, body, created_at, updated_at } = row;
    if (
        typeof id !== 'string' ||
        typeof owner !== 'string' ||
        typeof body !== 'string' ||
        typeof created_at !== 'string' ||
        typeof updated_at !== 'string'
    ) {
        throw new Error('memos テーブルの行の形が、想定と違います');
    }
    return { id, owner, body, createdAt: created_at, updatedAt: updated_at };
}

// データベースを開いて、テーブルを用意する(開けなければ、場所つきのエラー)
function openDatabase(path: string): DatabaseSync {
    let db: DatabaseSync | undefined;
    try {
        // ファイルの置き場(フォルダ)が、まだ無ければ、作る
        if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
        db = new DatabaseSync(path);
        db.exec(SCHEMA);
        return db;
    } catch (error) {
        db?.close();
        throw new Error(`データベースを開けませんでした: ${path}`, {
            cause: error,
        });
    }
}

export function createSqliteMemoStore(
    options: SqliteMemoStoreOptions,
): SqliteMemoStore {
    const now = options.now ?? Date.now;
    const generateId = options.generateId ?? randomUUID;
    const db = openDatabase(options.path);
    let closed = false;

    // SQL に、値を、文字列として繋げない。? に、あとから渡す(SQL インジェクションの対策)
    const insert = db.prepare(
        `INSERT INTO memos (${COLUMNS}) VALUES (?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
    );
    const selectById = db.prepare(`SELECT ${COLUMNS} FROM memos WHERE id = ?`);
    // rowid は、入れた順に増える番号(消しても、更新しても、順番は変わらない)
    const selectByOwner = db.prepare(
        `SELECT ${COLUMNS} FROM memos WHERE owner = ? ORDER BY rowid`,
    );
    const updateBody = db.prepare(
        `UPDATE memos SET body = ?, updated_at = ? WHERE id = ? RETURNING ${COLUMNS}`,
    );
    const deleteById = db.prepare('DELETE FROM memos WHERE id = ?');

    const timestamp = () => new Date(now()).toISOString();

    // SQLite は、孤立したサロゲート(壊れた UTF-16)を、別の文字(U+FFFD)に変えてしまう。黙って変えずに、断る
    const assertWellFormed = (body: string) => {
        if (!body.isWellFormed()) {
            throw new RangeError(
                '本文に、壊れた文字(孤立したサロゲート)があります',
            );
        }
    };

    return {
        async create({ owner, body }) {
            assertWellFormed(body);
            const at = timestamp();
            // 同じ id が既にあれば、PRIMARY KEY の制約で、エラーになる(上書きしない)
            const row = insert.get(generateId(), owner, body, at, at);
            if (!row) throw new Error('メモを作れませんでした');
            return toMemo(row);
        },

        async find(id) {
            const row = selectById.get(id);
            return row ? toMemo(row) : null;
        },

        async listByOwner(owner) {
            return selectByOwner.all(owner).map(toMemo);
        },

        async update(id, body) {
            assertWellFormed(body);
            const row = updateBody.get(body, timestamp(), id);
            return row ? toMemo(row) : null;
        },

        async delete(id) {
            return Number(deleteById.run(id).changes) > 0;
        },

        close() {
            if (closed) return;
            closed = true;
            db.close();
        },
    };
}
