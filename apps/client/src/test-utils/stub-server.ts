/**
 * 偽の AS や、偽の RS として動く、小さなサーバー(テスト専用)
 *   本物の HTTP で、届いたリクエストを記録して、決めておいた返事を返す
 */
import http, { type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type RecordedRequest = {
    method: string;
    // パスとクエリ(例: /token、/memos/abc?x=1)
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
};

export type StubHandler = (
    request: RecordedRequest,
    response: ServerResponse,
) => void | Promise<void>;

export type StubServer = {
    baseUrl: string;
    // 届いたリクエスト(届いた順)
    requests: RecordedRequest[];
    close: () => Promise<void>;
};

export async function startStubServer(
    handler: StubHandler,
): Promise<StubServer> {
    const requests: RecordedRequest[] = [];
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const recorded: RecordedRequest = {
                method: req.method ?? '',
                url: req.url ?? '',
                headers: req.headers,
                body: Buffer.concat(chunks).toString('utf8'),
            };
            requests.push(recorded);
            void handler(recorded, res);
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error ? reject(error) : resolve()));
            }),
    };
}

// JSON で返す(よく使う形)
export function sendJson(
    response: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
): void {
    response.writeHead(status, {
        'Content-Type': 'application/json',
        ...headers,
    });
    response.end(JSON.stringify(body));
}
