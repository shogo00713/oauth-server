import { createMemoryUserStore } from './memory-user-store.js';
import { userStoreContract } from './user-store.contract.js';

userStoreContract('メモリ', (users) => createMemoryUserStore(users));
