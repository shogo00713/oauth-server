import { describe, it, expect } from 'vitest';
import type { AuthCodeRecord, CodeStore } from './code-store.js';

const NOW = 1_700_000_000;
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_UNKNOWN = 'f'.repeat(64);

// テストごとに、新しい物を作る(書き換えられても、他のテストに影響しないように)
const record = (): AuthCodeRecord => ({
    clientId: 'memoboard',
    redirectUri: 'http://localhost:3000/callback',
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    sub: 'user-1',
    scope: ['read', 'write'],
    expiresAt: NOW + 60,
});

/**
 * CodeStore なら、どの実装でも通るはずのテスト
 * (メモリでも、SQLite でも、同じテストを使い回す)
 */
export function codeStoreContract(
    storeName: string,
    createStore: () => CodeStore | Promise<CodeStore>,
): void {
    describe(`CodeStore の約束(${storeName})`, () => {
        describe('save と consume', () => {
            it('save した記録を、consume で取り出せる', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                expect(await store.consume(HASH_A, NOW)).toEqual(record());
            });

            it('取り出せるのは、1 回だけ(2 回目は null)', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                await store.consume(HASH_A, NOW);

                expect(await store.consume(HASH_A, NOW)).toBeNull();
            });

            it('見つからない codeHash は、null', async () => {
                const store = await createStore();

                expect(await store.consume(HASH_UNKNOWN, NOW)).toBeNull();
            });

            it('consume しても、別の codeHash の記録は消えない', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());
                await store.save(HASH_B, { ...record(), sub: 'user-2' });

                await store.consume(HASH_A, NOW);

                expect(await store.consume(HASH_B, NOW)).toEqual({
                    ...record(),
                    sub: 'user-2',
                });
            });

            it('同じ codeHash をもう一度 save したら reject(最初の記録は、そのまま)', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                await expect(
                    store.save(HASH_A, { ...record(), sub: 'user-2' }),
                ).rejects.toThrow();

                expect(await store.consume(HASH_A, NOW)).toEqual(record());
            });
        });

        describe('期限(expiresAt)', () => {
            it('期限の 1 秒前は、取れる', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                expect(await store.consume(HASH_A, NOW + 59)).toEqual(record());
            });

            it('ちょうど期限は、もう取れない(JWT の exp と同じ境界)', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                expect(await store.consume(HASH_A, NOW + 60)).toBeNull();
            });

            it('期限を過ぎたら、取れない', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                expect(await store.consume(HASH_A, NOW + 61)).toBeNull();
            });

            it('期限切れで consume したら、記録は消える(あとで時刻を戻しても、取れない)', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                await store.consume(HASH_A, NOW + 60);

                expect(await store.consume(HASH_A, NOW)).toBeNull();
            });

            it('now を省略したら、今の時刻で判定する', async () => {
                const store = await createStore();
                const nowSec = Math.floor(Date.now() / 1000);
                await store.save(HASH_A, {
                    ...record(),
                    expiresAt: nowSec + 60,
                });
                await store.save(HASH_B, {
                    ...record(),
                    expiresAt: nowSec - 1,
                });

                expect(await store.consume(HASH_A)).not.toBeNull();
                expect(await store.consume(HASH_B)).toBeNull();
            });
        });

        describe('渡した物と返した物は、ストアとは別物', () => {
            it('save した後に、渡した record を書き換えても、影響しない', async () => {
                const store = await createStore();
                const original = record();
                await store.save(HASH_A, original);

                (original.scope as string[]).push('admin');
                original.sub = 'hacked';

                expect(await store.consume(HASH_A, NOW)).toEqual(record());
            });
        });

        describe('同時に呼んだ時', () => {
            it('同時に 2 回 consume しても、取れるのは 1 回だけ', async () => {
                const store = await createStore();
                await store.save(HASH_A, record());

                const results = await Promise.all([
                    store.consume(HASH_A, NOW),
                    store.consume(HASH_A, NOW),
                ]);

                expect(
                    results.filter((result) => result !== null),
                ).toHaveLength(1);
            });
        });
    });
}
