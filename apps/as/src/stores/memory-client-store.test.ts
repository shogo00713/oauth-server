import { clientStoreContract } from './client-store.contract.js';
import { createMemoryClientStore } from './memory-client-store.js';

clientStoreContract('メモリ', (clients) => createMemoryClientStore(clients));
