/**
 * ミドルウェアやルートのテスト用の道具(テスト専用)
 * - app を、空いているポートで起動する
 */
import type { Express } from 'express';
import type { AddressInfo } from 'node:net';

export type TestServer = {
    baseUrl: string;
    close: () => Promise<void>;
};

// app を、空いているポートで起動する(終わったら close を呼ぶ)
export async function startServer(app: Express): Promise<TestServer> {
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}
