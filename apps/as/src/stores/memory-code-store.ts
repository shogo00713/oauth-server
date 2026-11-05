import type { CodeStore } from './code-store.js';
import type { AuthCodeRecord } from './code-store.js';

export function createMemoryCodeStore(): CodeStore {
    const store = new Map<string, AuthCodeRecord>();

    return {
        async save(codeHash, record) {
            if (store.get(codeHash))
                throw new Error('same code has already exists!');
            store.set(codeHash, structuredClone(record));
        },

        async consume(codeHash, now = Math.floor(Date.now() / 1000)) {
            const record = store.get(codeHash);
            if (!record) return null;
            store.delete(codeHash);
            if (now >= record.expiresAt) return null;
            return record;
        },
    };
}
