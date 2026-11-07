import { describe, expect, it } from 'vitest';
import type { User, UserStore } from './user-store.js';

const ALICE: User = {
    id: 'user-1',
    username: 'alice',
    passwordHash: `$argon2id$v=19$m=1024,p=1,t=2$${'a'.repeat(22)}$${'b'.repeat(43)}`,
};

const BOB: User = {
    id: 'user-2',
    username: 'bob',
    passwordHash: `$argon2id$v=19$m=1024,p=1,t=2$${'c'.repeat(22)}$${'d'.repeat(43)}`,
};

// テストごとに、新しいコピーを使う(書き換えられても、他のテストに影響しないように)
const fresh = (user: User): User => structuredClone(user);

// 失敗した時の、エラーのメッセージ(失敗しなかったら、空文字)
const rejectionMessage = async (fn: () => unknown): Promise<string> => {
    try {
        await fn();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return '';
};

/**
 * UserStore なら、どの実装でも通るはずのテスト
 * (メモリでも、SQLite でも、同じテストを使い回す)
 */
export function userStoreContract(
    storeName: string,
    createStore: (users: readonly User[]) => UserStore | Promise<UserStore>,
): void {
    // 作る時に投げる実装でも、あとで reject する実装でも、同じに扱えるようにする
    const create = async (users: readonly User[]) => createStore(users);

    describe(`UserStore の約束(${storeName})`, () => {
        describe('findByUsername', () => {
            it('あるユーザーは、全部の項目つきで見つかる', async () => {
                const store = await create([fresh(ALICE), fresh(BOB)]);

                expect(await store.findByUsername('alice')).toEqual(ALICE);
            });

            it('複数あっても、それぞれ別々に見つかる', async () => {
                const store = await create([fresh(ALICE), fresh(BOB)]);

                expect(await store.findByUsername('bob')).toEqual(BOB);
            });

            it('無いユーザーは、null', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findByUsername('unknown')).toBeNull();
            });

            it('ユーザーが 0 件でも、null', async () => {
                const store = await create([]);

                expect(await store.findByUsername('alice')).toBeNull();
            });

            it('空文字は、null', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findByUsername('')).toBeNull();
            });

            it('大文字小文字は、区別する', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findByUsername('ALICE')).toBeNull();
                expect(await store.findByUsername('Alice')).toBeNull();
            });

            it.each([' alice', 'alice ', 'alice\n', '\talice'])(
                '前後の空白は、取り除かない: %j',
                async (username) => {
                    const store = await create([fresh(ALICE)]);

                    expect(await store.findByUsername(username)).toBeNull();
                },
            );

            it('ID では、見つからない', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findByUsername('user-1')).toBeNull();
            });

            it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
                'Object の名前でも、見つからない扱い(null): %s',
                async (username) => {
                    const store = await create([fresh(ALICE)]);

                    expect(await store.findByUsername(username)).toBeNull();
                },
            );
        });

        describe('findById', () => {
            it('あるユーザーは、全部の項目つきで見つかる', async () => {
                const store = await create([fresh(ALICE), fresh(BOB)]);

                expect(await store.findById('user-1')).toEqual(ALICE);
            });

            it('複数あっても、それぞれ別々に見つかる', async () => {
                const store = await create([fresh(ALICE), fresh(BOB)]);

                expect(await store.findById('user-2')).toEqual(BOB);
            });

            it('無い ID は、null', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findById('user-999')).toBeNull();
            });

            it('ユーザーが 0 件でも、null', async () => {
                const store = await create([]);

                expect(await store.findById('user-1')).toBeNull();
            });

            it('空文字は、null', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findById('')).toBeNull();
            });

            it('大文字小文字は、区別する', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findById('USER-1')).toBeNull();
            });

            it.each([' user-1', 'user-1 ', 'user-1\n'])(
                '前後の空白は、取り除かない: %j',
                async (id) => {
                    const store = await create([fresh(ALICE)]);

                    expect(await store.findById(id)).toBeNull();
                },
            );

            it('username では、見つからない', async () => {
                const store = await create([fresh(ALICE)]);

                expect(await store.findById('alice')).toBeNull();
            });

            it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
                'Object の名前でも、見つからない扱い(null): %s',
                async (id) => {
                    const store = await create([fresh(ALICE)]);

                    expect(await store.findById(id)).toBeNull();
                },
            );
        });

        describe('同じ人', () => {
            it('findByUsername と findById は、同じ内容を返す', async () => {
                const store = await create([fresh(ALICE), fresh(BOB)]);

                expect(await store.findByUsername('bob')).toEqual(
                    await store.findById('user-2'),
                );
            });
        });

        describe('渡した物と返した物は、ストアとは別物', () => {
            it('findByUsername の結果を書き換えても、次の検索に影響しない', async () => {
                const store = await create([fresh(ALICE)]);

                const found = await store.findByUsername('alice');
                if (!found) throw new Error('見つかるはず');
                found.username = 'hacked';
                found.passwordHash = 'hacked';

                expect(await store.findByUsername('alice')).toEqual(ALICE);
                expect(await store.findById('user-1')).toEqual(ALICE);
                expect(await store.findByUsername('hacked')).toBeNull();
            });

            it('findById の結果を書き換えても、次の検索に影響しない', async () => {
                const store = await create([fresh(ALICE)]);

                const found = await store.findById('user-1');
                if (!found) throw new Error('見つかるはず');
                found.id = 'hacked';
                found.passwordHash = 'hacked';

                expect(await store.findById('user-1')).toEqual(ALICE);
                expect(await store.findByUsername('alice')).toEqual(ALICE);
                expect(await store.findById('hacked')).toBeNull();
            });

            it('最初に渡した users を書き換えても、ストアに影響しない', async () => {
                const users = [fresh(ALICE)];
                const store = await create(users);

                const first = users[0];
                if (!first) throw new Error('あるはず');
                first.username = 'hacked';
                first.passwordHash = 'hacked';

                expect(await store.findByUsername('alice')).toEqual(ALICE);
                expect(await store.findByUsername('hacked')).toBeNull();
            });
        });

        describe('同じ人を、2 回入れた時', () => {
            it('同じ username のユーザーが 2 人いたら、作れない', async () => {
                // 比べるために、別の username なら、作れること
                const store = await create([fresh(ALICE), fresh(BOB)]);
                expect(await store.findByUsername('bob')).toEqual(BOB);

                await expect(
                    create([
                        fresh(ALICE),
                        { ...fresh(BOB), username: ALICE.username },
                    ]),
                ).rejects.toThrow();
            });

            it('同じ ID のユーザーが 2 人いたら、作れない', async () => {
                // 比べるために、別の ID なら、作れること
                const store = await create([fresh(ALICE), fresh(BOB)]);
                expect(await store.findById('user-2')).toEqual(BOB);

                await expect(
                    create([fresh(ALICE), { ...fresh(BOB), id: ALICE.id }]),
                ).rejects.toThrow();
            });

            it('エラーのメッセージに、passwordHash は入らない', async () => {
                // 比べるために、別の人どうしなら、作れること(エラーにならない)
                expect(
                    await rejectionMessage(() =>
                        create([fresh(ALICE), fresh(BOB)]),
                    ),
                ).toBe('');

                const sameName = await rejectionMessage(() =>
                    create([
                        fresh(ALICE),
                        { ...fresh(BOB), username: ALICE.username },
                    ]),
                );
                const sameId = await rejectionMessage(() =>
                    create([fresh(ALICE), { ...fresh(BOB), id: ALICE.id }]),
                );

                expect(sameName).not.toBe('');
                expect(sameId).not.toBe('');
                for (const message of [sameName, sameId]) {
                    expect(message).not.toContain(ALICE.passwordHash);
                    expect(message).not.toContain(BOB.passwordHash);
                }
            });
        });
    });
}
