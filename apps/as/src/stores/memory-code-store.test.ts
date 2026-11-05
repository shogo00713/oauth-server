import { codeStoreContract } from './code-store.contract.js';
import { createMemoryCodeStore } from './memory-code-store.js';

codeStoreContract('メモリ', () => createMemoryCodeStore());
