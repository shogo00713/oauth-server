import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { describeMemoStoreContract } from '../test-utils/memo-store-contract.js';
import {
    createSqliteMemoStore,
    type SqliteMemoStore,
    type SqliteMemoStoreOptions,
} from './sqlite-memo-store.js';

const START = Date.UTC(2030, 0, 1, 0, 0, 0);

// 長い本文のテストが、別々のファイルを使うための連番
let longCount = 0;

// コードの中に、直接書かずに、番号で作る(見えにくい文字)
const NUL = String.fromCharCode(0);
const HIGH_SURROGATE = String.fromCharCode(0xd83d);
const LOW_SURROGATE = String.fromCharCode(0xde00);

let tempDir: string;
// 開いたストアは、テストが終わったら、閉じる
const opened: SqliteMemoStore[] = [];

const open = (options: SqliteMemoStoreOptions): SqliteMemoStore => {
    const store = createSqliteMemoStore(options);
    opened.push(store);
    return store;
};

beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rs-sqlite-test-'));
});

afterEach(() => {
    for (const store of opened.splice(0)) store.close();
});

afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

// 固定の時計と、連番の id(memo-1、memo-2、...)
const fixed = () => {
    let sequence = 0;
    return {
        now: () => START,
        generateId: () => `memo-${++sequence}`,
    };
};

// どのストアも守る約束(create、find、listByOwner、update、delete)
describeMemoStoreContract('SQLite(メモリ)', (deps) =>
    open({ path: ':memory:', ...deps }),
);

let fileCount = 0;
describeMemoStoreContract('SQLite(ファイル)', (deps) =>
    open({ path: join(tempDir, `contract-${fileCount++}.db`), ...deps }),
);

describe('SQLITE-MEMO-STORE SQLite 版だけの決まり', () => {
    describe('ファイルへの保存(止めても、メモが残る)', () => {
        it('閉じて、開き直しても、メモが残る(本文、持ち主、日時、更新も、削除も)', async () => {
            const path = join(tempDir, 'persist.db');
            const first = open({ path, ...fixed() });
            await first.create({ owner: 'user-1', body: 'a' });
            await first.create({ owner: 'user-2', body: 'b' });
            await first.create({ owner: 'user-1', body: 'c' });
            const updated = await first.update('memo-1', 'a2');
            await first.delete('memo-2');
            const kept = await first.find('memo-3');
            first.close();

            const second = open({ path, ...fixed() });

            expect(await second.find('memo-1')).toEqual(updated);
            expect(await second.find('memo-3')).toEqual(kept);
            expect(await second.find('memo-2')).toBeNull();
            expect(
                (await second.listByOwner('user-1')).map((m) => m.body),
            ).toEqual(['a2', 'c']);
            expect(await second.listByOwner('user-2')).toEqual([]);
        });

        it('開き直したあとに作ったメモは、既にあるメモの、後ろに並ぶ', async () => {
            const path = join(tempDir, 'order.db');
            const first = open({ path, ...fixed() });
            await first.create({ owner: 'user-1', body: '1' });
            await first.create({ owner: 'user-1', body: '2' });
            first.close();

            const second = open({
                path,
                now: () => START,
                generateId: () => 'after-reopen',
            });
            await second.create({ owner: 'user-1', body: '3' });

            expect(
                (await second.listByOwner('user-1')).map((m) => m.body),
            ).toEqual(['1', '2', '3']);
        });

        it('何回開いても、テーブルを作り直さない(中身が消えない)', async () => {
            const path = join(tempDir, 'reopen.db');
            const first = open({ path, ...fixed() });
            await first.create({ owner: 'user-1', body: 'keep' });
            first.close();

            for (let i = 0; i < 3; i++) open({ path, ...fixed() }).close();

            const last = open({ path, ...fixed() });
            expect((await last.listByOwner('user-1')).length).toBe(1);
        });

        it('2 つのストアで、同じファイルを開いても、片方の変更が、もう片方から見える', async () => {
            const path = join(tempDir, 'shared.db');
            const a = open({ path, ...fixed() });
            const b = open({
                path,
                now: () => START,
                generateId: () => 'from-b',
            });

            await a.create({ owner: 'user-1', body: 'from a' });
            await b.create({ owner: 'user-1', body: 'from b' });

            expect((await a.listByOwner('user-1')).map((m) => m.body)).toEqual([
                'from a',
                'from b',
            ]);
            expect((await b.listByOwner('user-1')).map((m) => m.body)).toEqual([
                'from a',
                'from b',
            ]);
        });

        it('ファイルが、まだ無ければ、作る', async () => {
            const path = join(tempDir, 'new-file.db');
            expect(existsSync(path)).toBe(false);

            open({ path, ...fixed() });

            expect(existsSync(path)).toBe(true);
        });

        it('ファイルの置き場(フォルダ)が、まだ無ければ、フォルダも作る', async () => {
            const path = join(tempDir, 'a', 'b', 'c', 'deep.db');

            const store = open({ path, ...fixed() });
            await store.create({ owner: 'user-1', body: 'x' });

            expect(existsSync(path)).toBe(true);
        });

        it(':memory: は、ファイルを作らない。別々に作ったストアは、中身を共有しない', async () => {
            const a = open({ path: ':memory:', generateId: () => 'same-id' });
            const b = open({ path: ':memory:', generateId: () => 'same-id' });

            await a.create({ owner: 'user-1', body: 'in a' });

            expect(existsSync(':memory:')).toBe(false);
            expect(await b.find('same-id')).toBeNull();
        });
    });

    describe('日時', () => {
        it('作った時の、作成日時と更新日時は、同じ時刻(時計が、呼ぶたびに進んでも)', async () => {
            let calls = 0;
            const store = open({
                path: ':memory:',
                now: () => START + 1000 * calls++,
                generateId: () => 'memo-1',
            });

            const memo = await store.create({ owner: 'user-1', body: 'a' });

            expect(memo.updatedAt).toBe(memo.createdAt);
        });

        it('更新した時は、更新日時だけが変わる(作成日時は、そのまま)', async () => {
            const clock = { now: START };
            const store = open({
                path: ':memory:',
                now: () => clock.now,
                generateId: () => 'memo-1',
            });
            const created = await store.create({ owner: 'user-1', body: 'a' });
            clock.now = START + 90_000;

            const updated = await store.update('memo-1', 'b');

            expect(updated?.createdAt).toBe(created.createdAt);
            expect(updated?.updatedAt).toBe('2030-01-01T00:01:30.000Z');
        });
    });

    describe('一覧の並び', () => {
        it('id の並びではなく、作った順(id が、バラバラの順でも)', async () => {
            const ids = ['m-c', 'm-a', 'm-b'];
            const store = open({
                path: ':memory:',
                now: () => START,
                generateId: () => ids.shift() ?? 'unused',
            });
            for (const body of ['1', '2', '3'])
                await store.create({ owner: 'user-1', body });

            const list = await store.listByOwner('user-1');

            expect(list.map((memo) => memo.id)).toEqual(['m-c', 'm-a', 'm-b']);
            expect(list.map((memo) => memo.body)).toEqual(['1', '2', '3']);
        });

        it('更新日時の順ではなく、作った順(あとから更新しても、前の方に出る物は、前のまま)', async () => {
            const clock = { now: START };
            let sequence = 0;
            const store = open({
                path: ':memory:',
                now: () => clock.now,
                generateId: () => `memo-${++sequence}`,
            });
            await store.create({ owner: 'user-1', body: 'first' });
            clock.now = START + 1000;
            await store.create({ owner: 'user-1', body: 'second' });
            clock.now = START + 2000;
            await store.update('memo-1', 'first, updated last');

            const list = await store.listByOwner('user-1');

            expect(list.map((memo) => memo.id)).toEqual(['memo-1', 'memo-2']);
        });

        it('あとの方(新しい時刻)から先に作る時計でも、作った順', async () => {
            const times = [START + 5000, START + 1000, START + 3000];
            let sequence = 0;
            const store = open({
                path: ':memory:',
                now: () => times.shift() ?? START,
                generateId: () => `memo-${++sequence}`,
            });
            for (const body of ['1', '2', '3'])
                await store.create({ owner: 'user-1', body });

            const list = await store.listByOwner('user-1');

            expect(list.map((memo) => memo.body)).toEqual(['1', '2', '3']);
        });
    });

    describe('テーブルの形(docs/design/rs.md)', () => {
        const readRaw = (path: string) => {
            const db = new DatabaseSync(path);
            try {
                return {
                    columns: db
                        .prepare('PRAGMA table_info(memos)')
                        .all()
                        .map((column) => ({ ...column })),
                    rows: db
                        .prepare('SELECT * FROM memos ORDER BY rowid')
                        .all()
                        .map((row) => ({ ...row })),
                };
            } finally {
                db.close();
            }
        };

        it('memos テーブルの列は、id、owner、body、created_at、updated_at。id が主キー', async () => {
            const path = join(tempDir, 'schema.db');
            open({ path, ...fixed() });

            const { columns } = readRaw(path);

            expect(columns.map((c) => c['name'])).toEqual([
                'id',
                'owner',
                'body',
                'created_at',
                'updated_at',
            ]);
            expect(
                columns.filter((c) => c['pk'] === 1).map((c) => c['name']),
            ).toEqual(['id']);
        });

        it('持ち主、本文、日時の列は、空(NULL)にできない', async () => {
            const path = join(tempDir, 'notnull.db');
            open({ path, ...fixed() });

            const { columns } = readRaw(path);

            for (const name of ['owner', 'body', 'created_at', 'updated_at'])
                expect(
                    columns.find((c) => c['name'] === name)?.['notnull'],
                ).toBe(1);
        });

        it('入っている物は、メモそのまま(日時は、ISO 8601 の文字)', async () => {
            const path = join(tempDir, 'raw.db');
            const store = open({ path, ...fixed() });
            await store.create({ owner: 'user-1', body: '  あ\n😀  ' });
            await store.update('memo-1', 'after');

            const { rows } = readRaw(path);

            expect(rows).toEqual([
                {
                    id: 'memo-1',
                    owner: 'user-1',
                    body: 'after',
                    created_at: '2030-01-01T00:00:00.000Z',
                    updated_at: '2030-01-01T00:00:00.000Z',
                },
            ]);
        });

        it('文字に直せない値(バイナリ)は、入れられない(STRICT テーブル)', async () => {
            const path = join(tempDir, 'strict.db');
            open({ path, ...fixed() });
            const db = new DatabaseSync(path);

            try {
                expect(() =>
                    db.exec(
                        "INSERT INTO memos VALUES ('x', 'owner', x'00ff', 't', 't')",
                    ),
                ).toThrow();
            } finally {
                db.close();
            }
        });

        it('消したメモは、本当に、テーブルから無くなる', async () => {
            const path = join(tempDir, 'deleted.db');
            const store = open({ path, ...fixed() });
            await store.create({ owner: 'user-1', body: 'a' });
            await store.create({ owner: 'user-1', body: 'b' });

            await store.delete('memo-1');

            expect(readRaw(path).rows.map((row) => row['id'])).toEqual([
                'memo-2',
            ]);
        });
    });

    describe('特別な文字(SQL の注入、LIKE の記号、NUL、長い本文)', () => {
        const DANGEROUS = [
            "'; DROP TABLE memos; --",
            '" OR 1=1 --',
            "x' OR '1'='1",
            "a'b",
            '\\',
            'ü',
            '😀',
        ];

        it.each(DANGEROUS)(
            '持ち主と本文が %j でも、そのまま保存されて、その人の一覧にだけ出る。テーブルは、無事',
            async (value) => {
                const store = open({ path: ':memory:', ...fixed() });
                await store.create({ owner: value, body: value });
                await store.create({ owner: 'someone-else', body: 'other' });

                const list = await store.listByOwner(value);

                expect(list).toHaveLength(1);
                expect(list[0]).toMatchObject({ owner: value, body: value });
                expect(await store.listByOwner('someone-else')).toHaveLength(1);
            },
        );

        it.each(DANGEROUS)(
            'id が %j でも、そのまま保存されて、find、update、delete できる。テーブルは、無事',
            async (value) => {
                const store = open({
                    path: ':memory:',
                    now: () => START,
                    generateId: () => value,
                });
                await store.create({ owner: 'user-1', body: 'a' });

                expect((await store.find(value))?.id).toBe(value);
                expect((await store.update(value, 'b'))?.body).toBe('b');
                expect(await store.delete(value)).toBe(true);
                expect(await store.find(value)).toBeNull();
                // テーブルが無事なら、また作れる
                await expect(
                    store.create({ owner: 'user-1', body: 'again' }),
                ).resolves.toMatchObject({ id: value });
            },
        );

        it('検索の記号(% と _)は、ただの文字。持ち主も、id も、完全に同じ物だけ', async () => {
            const owners = ['%', '_', 'user-1'];
            let sequence = 0;
            const store = open({
                path: ':memory:',
                now: () => START,
                generateId: () => `memo-${++sequence}`,
            });
            for (const owner of owners)
                await store.create({ owner, body: `by ${owner}` });

            expect((await store.listByOwner('%')).map((m) => m.body)).toEqual([
                'by %',
            ]);
            expect((await store.listByOwner('_')).map((m) => m.body)).toEqual([
                'by _',
            ]);
            expect(await store.find('%')).toBeNull();
            expect(await store.find('memo-_')).toBeNull();
            expect(await store.find('memo-%')).toBeNull();
            expect(await store.update('memo-_', 'changed')).toBeNull();
            expect(await store.update('memo-%', 'changed')).toBeNull();
            expect(await store.update('%', 'changed')).toBeNull();
            expect((await store.find('memo-1'))?.body).toBe('by %');
            expect(await store.delete('%')).toBe(false);
            expect(await store.delete('memo-_')).toBe(false);
            expect((await store.listByOwner('user-1')).length).toBe(1);
        });

        it('本文に NUL(U+0000)があっても、そのまま保存される', async () => {
            const store = open({ path: ':memory:', ...fixed() });
            const body = `a${NUL}b${NUL}`;

            const memo = await store.create({ owner: 'user-1', body });

            expect(memo.body).toBe(body);
            expect((await store.find(memo.id))?.body).toBe(body);
        });

        it.each([
            { name: '10000 文字', body: 'a'.repeat(10_000) },
            { name: '絵文字 10000 個', body: '😀'.repeat(10_000) },
            { name: '改行の連続', body: '\r\n'.repeat(5000) },
        ])('長い本文($name)も、そのまま保存される', async ({ body }) => {
            const path = join(tempDir, `long-${longCount++}.db`);
            const store = open({ path, ...fixed() });

            await store.create({ owner: 'user-1', body });
            store.close();

            const reopened = open({ path, ...fixed() });
            expect((await reopened.find('memo-1'))?.body).toBe(body);
        });
    });

    describe('壊れた UTF-16(孤立したサロゲート)は、断る(SQLite は、別の文字に変えてしまうので)', () => {
        it.each([
            { name: '高い方だけ', body: `a${HIGH_SURROGATE}b` },
            { name: '低い方だけ', body: `a${LOW_SURROGATE}b` },
            { name: '末尾が高い方だけ', body: `abc${HIGH_SURROGATE}` },
        ])(
            'create: $name は、RangeError。何も保存されない',
            async ({ body }) => {
                const store = open({ path: ':memory:', ...fixed() });

                await expect(
                    store.create({ owner: 'user-1', body }),
                ).rejects.toThrow(RangeError);

                expect(await store.listByOwner('user-1')).toEqual([]);
            },
        );

        it.each([
            { name: '高い方だけ', body: `a${HIGH_SURROGATE}b` },
            { name: '低い方だけ', body: `a${LOW_SURROGATE}b` },
        ])(
            'update: $name は、RangeError。元の本文も、更新日時も、そのまま',
            async ({ body }) => {
                const clock = { now: START };
                const store = open({
                    path: ':memory:',
                    now: () => clock.now,
                    generateId: () => 'memo-1',
                });
                const before = await store.create({
                    owner: 'user-1',
                    body: 'before',
                });
                clock.now = START + 60_000;

                await expect(store.update('memo-1', body)).rejects.toThrow(
                    RangeError,
                );

                expect(await store.find('memo-1')).toEqual(before);
            },
        );

        it('組になっている(絵文字の)サロゲートは、良い', async () => {
            const store = open({ path: ':memory:', ...fixed() });
            const body = `a${HIGH_SURROGATE}${LOW_SURROGATE}b`;

            const memo = await store.create({ owner: 'user-1', body });

            expect(memo.body).toBe('a😀b');
        });
    });

    describe('開けない時(場所つきのエラー。元の例外は、cause に残る)', () => {
        it('フォルダを指していたら、エラー', () => {
            expect(() => createSqliteMemoStore({ path: tempDir })).toThrow(
                tempDir,
            );
            expect(() => createSqliteMemoStore({ path: tempDir })).toThrow(
                expect.objectContaining({ cause: expect.any(Error) }),
            );
        });

        it('SQLite のファイルじゃなかったら、エラー(中身を、上書きしない)', () => {
            const path = join(tempDir, 'not-a-database.db');
            const content = 'not a database. '.repeat(400);
            writeFileSync(path, content);

            expect(() => createSqliteMemoStore({ path })).toThrow(path);
            expect(() => createSqliteMemoStore({ path })).toThrow(
                expect.objectContaining({ cause: expect.any(Error) }),
            );
            // 元のファイルは、そのまま
            expect(existsSync(path)).toBe(true);
        });

        it('置き場(フォルダ)にしたい所が、普通のファイルなら、エラー', () => {
            const file = join(tempDir, 'plain-file');
            writeFileSync(file, 'x');
            const path = join(file, 'x.db');

            expect(() => createSqliteMemoStore({ path })).toThrow(path);
            expect(() => createSqliteMemoStore({ path })).toThrow(
                expect.objectContaining({ cause: expect.any(Error) }),
            );
        });

        it('開けなかった後も、同じ場所を、使える物にして開き直せる(開きかけの接続を、残さない)', () => {
            const path = join(tempDir, 'retry.db');
            writeFileSync(path, 'not a database. '.repeat(400));
            expect(() => createSqliteMemoStore({ path })).toThrow();
            rmSync(path);

            const store = open({ path, ...fixed() });

            expect(store).toBeDefined();
        });
    });

    describe('close', () => {
        it('閉じたあとは、どの操作も、失敗する', async () => {
            const store = open({ path: ':memory:', ...fixed() });
            await store.create({ owner: 'user-1', body: 'a' });

            store.close();

            await expect(store.find('memo-1')).rejects.toThrow();
            await expect(store.listByOwner('user-1')).rejects.toThrow();
            await expect(
                store.create({ owner: 'user-1', body: 'b' }),
            ).rejects.toThrow();
            await expect(store.update('memo-1', 'c')).rejects.toThrow();
            await expect(store.delete('memo-1')).rejects.toThrow();
        });

        it('2 回閉じても、エラーにならない', () => {
            const store = open({ path: ':memory:', ...fixed() });

            store.close();

            expect(() => store.close()).not.toThrow();
        });

        it('閉じる前に作ったメモは、閉じたあとも、ファイルに残っている', async () => {
            const path = join(tempDir, 'close.db');
            const store = open({ path, ...fixed() });
            await store.create({ owner: 'user-1', body: 'kept' });

            store.close();

            const reopened = open({ path, ...fixed() });
            expect((await reopened.find('memo-1'))?.body).toBe('kept');
        });
    });

    describe('省略した時の、既定', () => {
        it('id は、UUID(v4)で、作るたびに違う', async () => {
            const store = open({ path: ':memory:' });

            const ids = new Set<string>();
            for (let i = 0; i < 100; i++) {
                const memo = await store.create({ owner: 'u', body: 'a' });
                expect(memo.id).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
                );
                ids.add(memo.id);
            }

            expect(ids.size).toBe(100);
        });

        it('日時は、本物の時計', async () => {
            const store = open({ path: ':memory:' });

            const before = Date.now();
            const memo = await store.create({ owner: 'u', body: 'a' });
            const after = Date.now();

            const created = Date.parse(memo.createdAt);
            expect(created).toBeGreaterThanOrEqual(before);
            expect(created).toBeLessThanOrEqual(after);
        });

        it('id だけ差し替えても、日時は本物の時計', async () => {
            const store = open({
                path: ':memory:',
                generateId: () => 'fixed',
            });

            const before = Date.now();
            const memo = await store.create({ owner: 'u', body: 'a' });

            expect(memo.id).toBe('fixed');
            expect(Date.parse(memo.createdAt)).toBeGreaterThanOrEqual(before);
        });

        it('時計だけ差し替えても、id は UUID', async () => {
            const store = open({ path: ':memory:', now: () => 0 });

            const memo = await store.create({ owner: 'u', body: 'a' });

            expect(memo.createdAt).toBe('1970-01-01T00:00:00.000Z');
            expect(memo.id).toMatch(/^[0-9a-f-]{36}$/);
        });
    });
});
