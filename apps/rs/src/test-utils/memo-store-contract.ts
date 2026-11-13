/**
 * メモのストアの「約束」のテスト(テスト専用)
 *   どのストアの作りでも、同じ約束を守ること。今はメモリ版。C6 の SQLite 版にも、同じ物を使う
 *   使い方: describeMemoStoreContract('名前', (deps) => ストアを作る)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { MemoStore } from '../stores/memo-store.js';

export type MemoStoreDeps = {
    // 今の時刻(ミリ秒)を返す関数
    now: () => number;
    // メモの id を作る関数
    generateId: () => string;
};

export type MemoStoreFactory = (
    deps: MemoStoreDeps,
) => MemoStore | Promise<MemoStore>;

const START = Date.UTC(2030, 0, 1, 0, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

export function describeMemoStoreContract(
    name: string,
    factory: MemoStoreFactory,
) {
    describe(`MEMO-STORE メモのストアの約束(${name})`, () => {
        // テストの中の時計(ミリ秒)と、id の連番
        const clock = { now: START };
        let sequence = 0;
        let store: MemoStore;

        const deps = (): MemoStoreDeps => ({
            now: () => clock.now,
            generateId: () => `memo-${++sequence}`,
        });

        beforeEach(async () => {
            clock.now = START;
            sequence = 0;
            store = await factory(deps());
        });

        describe('create', () => {
            it('id、持ち主、本文、作成日時、更新日時を持つメモを返す', async () => {
                const memo = await store.create({
                    owner: 'user-1',
                    body: 'hello',
                });

                expect(memo).toEqual({
                    id: 'memo-1',
                    owner: 'user-1',
                    body: 'hello',
                    createdAt: iso(START),
                    updatedAt: iso(START),
                });
            });

            it('id は、作るたびに、id を作る関数から取る', async () => {
                const a = await store.create({ owner: 'user-1', body: 'a' });
                const b = await store.create({ owner: 'user-1', body: 'b' });

                expect([a.id, b.id]).toEqual(['memo-1', 'memo-2']);
            });

            it('日時は、今の時刻(ISO 8601、UTC)。時計が進めば、進んだ時刻', async () => {
                const first = await store.create({
                    owner: 'user-1',
                    body: 'a',
                });
                clock.now = START + 90_000;
                const second = await store.create({
                    owner: 'user-1',
                    body: 'b',
                });

                expect(first.createdAt).toBe('2030-01-01T00:00:00.000Z');
                expect(second.createdAt).toBe('2030-01-01T00:01:30.000Z');
                expect(second.updatedAt).toBe(second.createdAt);
            });

            it('本文は、加工しない(前後の空白、改行、絵文字も、そのまま)', async () => {
                const body = '  あ\n😀\r\n  ';

                const memo = await store.create({ owner: 'user-1', body });

                expect(memo.body).toBe(body);
                expect((await store.find(memo.id))?.body).toBe(body);
            });

            it('作ったメモは、find でも、一覧でも、見つかる', async () => {
                const memo = await store.create({
                    owner: 'user-1',
                    body: 'hello',
                });

                expect(await store.find(memo.id)).toEqual(memo);
                expect(await store.listByOwner('user-1')).toEqual([memo]);
            });

            it('返したメモを書き換えても、ストアの中は変わらない', async () => {
                const memo = await store.create({
                    owner: 'user-1',
                    body: 'hello',
                });

                memo.body = 'changed';
                memo.owner = 'attacker';

                expect(await store.find('memo-1')).toMatchObject({
                    body: 'hello',
                    owner: 'user-1',
                });
            });

            it('同じ id が既にあれば、上書きせずに、エラー(元のメモは、そのまま)', async () => {
                const same = await factory({
                    now: () => clock.now,
                    generateId: () => 'same-id',
                });
                await same.create({ owner: 'user-1', body: 'first' });

                await expect(
                    same.create({ owner: 'user-2', body: 'second' }),
                ).rejects.toThrow();

                expect(await same.find('same-id')).toMatchObject({
                    owner: 'user-1',
                    body: 'first',
                });
            });
        });

        describe('find', () => {
            it('作ったメモが、そのまま返る', async () => {
                const memo = await store.create({
                    owner: 'user-1',
                    body: 'hello',
                });

                expect(await store.find(memo.id)).toEqual(memo);
            });

            it('持ち主が違っても、見つかる(持ち主の判定は、ストアの仕事ではない)', async () => {
                const memo = await store.create({
                    owner: 'user-1',
                    body: 'hello',
                });

                expect((await store.find(memo.id))?.owner).toBe('user-1');
            });

            it.each([
                { name: '無い id', id: 'nothing' },
                { name: '空文字', id: '' },
                { name: '大文字小文字が違う', id: 'MEMO-1' },
                { name: '前方一致', id: 'memo' },
                { name: '後ろに文字が付いている', id: 'memo-10' },
            ])('見つからなければ、null: $name', async ({ id }) => {
                await store.create({ owner: 'user-1', body: 'hello' });

                expect(await store.find(id)).toBeNull();
            });

            it('返したメモを書き換えても、ストアの中は変わらない', async () => {
                await store.create({ owner: 'user-1', body: 'hello' });

                const found = await store.find('memo-1');
                if (found) found.body = 'changed';

                expect((await store.find('memo-1'))?.body).toBe('hello');
            });
        });

        describe('listByOwner', () => {
            it('その人のメモだけを返す', async () => {
                await store.create({ owner: 'user-1', body: 'a' });
                await store.create({ owner: 'user-2', body: 'b' });
                await store.create({ owner: 'user-1', body: 'c' });

                const list = await store.listByOwner('user-1');

                expect(list.map((memo) => memo.body)).toEqual(['a', 'c']);
                expect(list.every((memo) => memo.owner === 'user-1')).toBe(
                    true,
                );
            });

            it('メモが無ければ、空の配列', async () => {
                await store.create({ owner: 'user-1', body: 'a' });

                expect(await store.listByOwner('user-2')).toEqual([]);
                expect(await store.listByOwner('')).toEqual([]);
            });

            it.each([
                { name: '後ろに文字が付いている', owner: 'user-10' },
                { name: '前方一致', owner: 'user' },
                { name: '大文字小文字が違う', owner: 'USER-1' },
            ])('持ち主は、完全に同じ物だけ: $name', async ({ owner }) => {
                await store.create({ owner: 'user-1', body: 'a' });
                await store.create({ owner: 'user-10', body: 'b' });

                const list = await store.listByOwner(owner);

                expect(list.map((memo) => memo.body)).toEqual(
                    owner === 'user-10' ? ['b'] : [],
                );
            });

            it('作った順(古い順)。時計が同じでも、その順番', async () => {
                for (const body of ['1', '2', '3', '4'])
                    await store.create({ owner: 'user-1', body });

                const list = await store.listByOwner('user-1');

                expect(list.map((memo) => memo.body)).toEqual([
                    '1',
                    '2',
                    '3',
                    '4',
                ]);
            });

            it('更新しても、順番は変わらない', async () => {
                await store.create({ owner: 'user-1', body: '1' });
                await store.create({ owner: 'user-1', body: '2' });
                await store.create({ owner: 'user-1', body: '3' });

                clock.now = START + 1000;
                await store.update('memo-1', 'changed');

                const list = await store.listByOwner('user-1');
                expect(list.map((memo) => memo.body)).toEqual([
                    'changed',
                    '2',
                    '3',
                ]);
            });

            it('消したメモは、出てこない', async () => {
                await store.create({ owner: 'user-1', body: '1' });
                await store.create({ owner: 'user-1', body: '2' });

                await store.delete('memo-1');

                const list = await store.listByOwner('user-1');
                expect(list.map((memo) => memo.body)).toEqual(['2']);
            });

            it('返した配列やメモを書き換えても、ストアの中は変わらない', async () => {
                await store.create({ owner: 'user-1', body: 'a' });

                const list = await store.listByOwner('user-1');
                list[0]!.body = 'changed';
                list.pop();

                const again = await store.listByOwner('user-1');
                expect(again.map((memo) => memo.body)).toEqual(['a']);
            });
        });

        describe('update', () => {
            it('本文と更新日時が変わる。id、持ち主、作成日時は、変わらない', async () => {
                await store.create({ owner: 'user-1', body: 'before' });
                clock.now = START + 60_000;

                const updated = await store.update('memo-1', 'after');

                expect(updated).toEqual({
                    id: 'memo-1',
                    owner: 'user-1',
                    body: 'after',
                    createdAt: iso(START),
                    updatedAt: iso(START + 60_000),
                });
            });

            it('更新した内容が、find にも反映される', async () => {
                await store.create({ owner: 'user-1', body: 'before' });
                clock.now = START + 60_000;

                const updated = await store.update('memo-1', 'after');

                expect(await store.find('memo-1')).toEqual(updated);
            });

            it('本文が同じでも、更新日時は、今になる', async () => {
                await store.create({ owner: 'user-1', body: 'same' });
                clock.now = START + 5000;

                const updated = await store.update('memo-1', 'same');

                expect(updated?.updatedAt).toBe(iso(START + 5000));
            });

            it('本文は、加工しない(前後の空白、改行、絵文字も、そのまま)', async () => {
                await store.create({ owner: 'user-1', body: 'before' });

                const updated = await store.update('memo-1', ' \n😀 ');

                expect(updated?.body).toBe(' \n😀 ');
            });

            it('無い id は、null(何も作らない)', async () => {
                expect(await store.update('nothing', 'body')).toBeNull();
                expect(await store.find('nothing')).toBeNull();
                expect(await store.listByOwner('user-1')).toEqual([]);
            });

            it('他のメモは、変わらない', async () => {
                const other = await store.create({
                    owner: 'user-2',
                    body: 'other',
                });
                await store.create({ owner: 'user-1', body: 'mine' });
                clock.now = START + 1000;

                await store.update('memo-2', 'changed');

                expect(await store.find(other.id)).toEqual(other);
            });

            it('返したメモを書き換えても、ストアの中は変わらない', async () => {
                await store.create({ owner: 'user-1', body: 'before' });

                const updated = await store.update('memo-1', 'after');
                if (updated) updated.body = 'changed';

                expect((await store.find('memo-1'))?.body).toBe('after');
            });
        });

        describe('delete', () => {
            it('消したら true。find でも、一覧でも、見つからない', async () => {
                await store.create({ owner: 'user-1', body: 'hello' });

                expect(await store.delete('memo-1')).toBe(true);

                expect(await store.find('memo-1')).toBeNull();
                expect(await store.listByOwner('user-1')).toEqual([]);
            });

            it('もう一度消すと、false', async () => {
                await store.create({ owner: 'user-1', body: 'hello' });
                await store.delete('memo-1');

                expect(await store.delete('memo-1')).toBe(false);
            });

            it.each(['nothing', '', 'MEMO-1', 'memo'])(
                '無い id は、false: %j',
                async (id) => {
                    await store.create({ owner: 'user-1', body: 'hello' });

                    expect(await store.delete(id)).toBe(false);
                    expect(await store.find('memo-1')).not.toBeNull();
                },
            );

            it('他のメモは、残る', async () => {
                await store.create({ owner: 'user-1', body: 'a' });
                const keep = await store.create({
                    owner: 'user-1',
                    body: 'b',
                });

                await store.delete('memo-1');

                expect(await store.find('memo-2')).toEqual(keep);
            });

            it('消した後の id は、また使える(同じ id で作り直せる)', async () => {
                const same = await factory({
                    now: () => clock.now,
                    generateId: () => 'same-id',
                });
                await same.create({ owner: 'user-1', body: 'first' });
                await same.delete('same-id');

                const again = await same.create({
                    owner: 'user-2',
                    body: 'second',
                });

                expect(again).toMatchObject({
                    id: 'same-id',
                    owner: 'user-2',
                    body: 'second',
                });
            });
        });
    });
}
