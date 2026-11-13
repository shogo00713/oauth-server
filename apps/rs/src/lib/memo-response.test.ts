import { describe, expect, it } from 'vitest';
import type { Memo } from '../stores/memo-store.js';
import { toMemoResponse } from './memo-response.js';

const memo = (): Memo => ({
    id: 'memo-1',
    owner: 'user-1',
    body: 'hello',
    createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-02T00:00:00.000Z',
});

describe('MEMO-RESPONSE API の返事に載せる、メモの形', () => {
    describe('toMemoResponse', () => {
        it('id、body、createdAt、updatedAt を、そのまま持つ', () => {
            expect(toMemoResponse(memo())).toEqual({
                id: 'memo-1',
                body: 'hello',
                createdAt: '2030-01-01T00:00:00.000Z',
                updatedAt: '2030-01-02T00:00:00.000Z',
            });
        });

        it('持ち主(owner)は、載せない', () => {
            const result = toMemoResponse(memo());

            expect(result).not.toHaveProperty('owner');
            expect(JSON.stringify(result)).not.toContain('user-1');
        });

        it('決まった 4 つの項目だけ(Memo に、知らない項目が付いていても、載せない)', () => {
            const withExtra = { ...memo(), secret: 'internal' } as Memo;

            const result = toMemoResponse(withExtra);

            expect(Object.keys(result).sort()).toEqual([
                'body',
                'createdAt',
                'id',
                'updatedAt',
            ]);
        });

        it('渡した物とは別の、新しい物を返す。渡した物は、書き換えない', () => {
            const input = memo();

            const result = toMemoResponse(input);
            result.body = 'changed';

            expect(input).toEqual(memo());
        });
    });
});
