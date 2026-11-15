import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // 本物のサーバーを 3 つ起動するので、他のアプリのテストより、時間の枠を広くとる
        testTimeout: 30_000,
        hookTimeout: 60_000,
    },
});
