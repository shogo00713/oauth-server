import { describe, it, expect } from 'vitest';
import type { Client, ClientStore } from './client-store.js';

const MEMOBOARD: Client = {
    clientId: 'memoboard',
    secretHash: 'a'.repeat(64),
    name: 'メモボード',
    redirectUris: [
        'http://localhost:3000/callback',
        'http://127.0.0.1:3000/callback',
    ],
};

const OTHER_APP: Client = {
    clientId: 'other-app',
    secretHash: 'b'.repeat(64),
    name: '別のアプリ',
    redirectUris: ['https://other.example.com/cb'],
};

// テストごとに、新しいコピーを使う(書き換えられても、他のテストに影響しないように)
const fresh = (client: Client): Client => structuredClone(client);

/**
 * ClientStore なら、どの実装でも通るはずのテスト
 * (メモリでも、SQLite でも、同じテストを使い回す)
 */
export function clientStoreContract(
    storeName: string,
    createStore: (
        clients: readonly Client[],
    ) => ClientStore | Promise<ClientStore>,
): void {
    describe(`ClientStore の約束(${storeName})`, () => {
        describe('find', () => {
            it('あるクライアントは、全部の項目つきで見つかる', async () => {
                const store = await createStore([
                    fresh(MEMOBOARD),
                    fresh(OTHER_APP),
                ]);

                expect(await store.find('memoboard')).toEqual(MEMOBOARD);
            });

            it('複数あっても、それぞれ別々に見つかる', async () => {
                const store = await createStore([
                    fresh(MEMOBOARD),
                    fresh(OTHER_APP),
                ]);

                expect(await store.find('other-app')).toEqual(OTHER_APP);
            });

            it('無いクライアントは、null', async () => {
                const store = await createStore([fresh(MEMOBOARD)]);

                expect(await store.find('unknown')).toBeNull();
            });

            it('クライアントが 0 件でも、null', async () => {
                const store = await createStore([]);

                expect(await store.find('memoboard')).toBeNull();
            });

            it('空文字は、null', async () => {
                const store = await createStore([fresh(MEMOBOARD)]);

                expect(await store.find('')).toBeNull();
            });

            it('大文字小文字は、区別する', async () => {
                const store = await createStore([fresh(MEMOBOARD)]);

                expect(await store.find('MEMOBOARD')).toBeNull();
            });

            it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
                'Object の名前でも、見つからない扱い(null): %s',
                async (clientId) => {
                    const store = await createStore([fresh(MEMOBOARD)]);

                    expect(await store.find(clientId)).toBeNull();
                },
            );
        });

        describe('渡した物と返した物は、ストアとは別物', () => {
            it('返された物を書き換えても、次の find に影響しない', async () => {
                const store = await createStore([fresh(MEMOBOARD)]);

                const found = await store.find('memoboard');
                if (!found) throw new Error('見つかるはず');
                found.name = 'hacked';
                (found.redirectUris as string[]).push(
                    'http://evil.example.com/cb',
                );

                expect(await store.find('memoboard')).toEqual(MEMOBOARD);
            });

            it('最初に渡した clients を書き換えても、ストアに影響しない', async () => {
                const clients = [fresh(MEMOBOARD)];
                const store = await createStore(clients);

                const first = clients[0];
                if (!first) throw new Error('あるはず');
                first.name = 'hacked';
                (first.redirectUris as string[]).push(
                    'http://evil.example.com/cb',
                );

                expect(await store.find('memoboard')).toEqual(MEMOBOARD);
            });
        });
    });
}
