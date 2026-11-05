import type { Client, ClientStore } from './client-store.js';

export function createMemoryClientStore(
    clients: readonly Client[],
): ClientStore {
    const store = new Map(
        clients.map(
            (client) => [client.clientId, structuredClone(client)] as const,
        ),
    );

    return {
        async find(clientId) {
            const client = store.get(clientId);
            return client ? structuredClone(client) : null;
        },
    };
}
