import { describe, expect, it } from 'vitest';
import { describeMemoStoreContract } from '../test-utils/memo-store-contract.js';
import { createMemoryMemoStore } from './memory-memo-store.js';

// どのストアも守る約束(create、find、listByOwner、update、delete)
describeMemoStoreContract('メモリ', (deps) => createMemoryMemoStore(deps));

describe('MEMORY-MEMO-STORE メモリ版だけの決まり', () => {
    describe('省略した時の、既定', () => {
        it('id は、UUID(v4)で、作るたびに違う', async () => {
            const store = createMemoryMemoStore();

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
            const store = createMemoryMemoStore();

            const before = Date.now();
            const memo = await store.create({ owner: 'u', body: 'a' });
            const after = Date.now();

            const created = Date.parse(memo.createdAt);
            expect(created).toBeGreaterThanOrEqual(before);
            expect(created).toBeLessThanOrEqual(after);
        });

        it('id だけ差し替えても、日時は本物の時計', async () => {
            const store = createMemoryMemoStore({ generateId: () => 'fixed' });

            const before = Date.now();
            const memo = await store.create({ owner: 'u', body: 'a' });

            expect(memo.id).toBe('fixed');
            expect(Date.parse(memo.createdAt)).toBeGreaterThanOrEqual(before);
        });

        it('時計だけ差し替えても、id は UUID', async () => {
            const store = createMemoryMemoStore({ now: () => 0 });

            const memo = await store.create({ owner: 'u', body: 'a' });

            expect(memo.createdAt).toBe('1970-01-01T00:00:00.000Z');
            expect(memo.id).toMatch(/^[0-9a-f-]{36}$/);
        });
    });

    it('別々に作ったストアは、中身を共有しない', async () => {
        const a = createMemoryMemoStore({ generateId: () => 'same-id' });
        const b = createMemoryMemoStore({ generateId: () => 'same-id' });

        await a.create({ owner: 'u', body: 'in a' });

        expect(await b.find('same-id')).toBeNull();
        await expect(
            b.create({ owner: 'u', body: 'in b' }),
        ).resolves.toMatchObject({ body: 'in b' });
    });
});
