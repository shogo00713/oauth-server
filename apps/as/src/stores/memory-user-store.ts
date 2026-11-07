import type { User, UserStore } from './user-store.js';

export function createMemoryUserStore(users: readonly User[]): UserStore {
    const store = new Map<string, User>();
    const usernames = new Set<string>();
    for (const user of users) {
        if (store.has(user.id)) {
            throw new RangeError(`user ID is duplicated: ${user.id}`);
        }
        if (usernames.has(user.username)) {
            throw new RangeError(`username is duplicated: ${user.username}`);
        }
        store.set(user.id, structuredClone(user));
        usernames.add(user.username);
    }

    return {
        async findByUsername(username) {
            for (const user of store.values()) {
                if (user.username === username) {
                    return structuredClone(user);
                }
            }
            return null;
        },
        async findById(id) {
            const user = store.get(id);
            return user ? structuredClone(user) : null;
        },
    };
}
