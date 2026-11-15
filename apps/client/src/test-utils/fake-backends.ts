/**
 * 偽の AS(/token だけ)と、偽の RS(/memos)を、本物の HTTP で動かす(テスト専用)
 *   client の app を、全部つないだ形でテストするための物
 */
import type { Memo } from '../rs/memo-api.js';
import {
    sendJson,
    startStubServer,
    type RecordedRequest,
    type StubServer,
} from './stub-server.js';

// 偽の AS が発行する、アクセストークン(偽の RS が、これだけを受け付ける)
export const FAKE_ACCESS_TOKEN = 'fake-access-token-for-tests';

export type FakeBackends = {
    // 偽の AS の URL(/token がある)
    asBaseUrl: string;
    // 偽の RS の URL(/memos がある)
    rsBaseUrl: string;
    // 偽の AS の /token に届いたリクエスト
    tokenRequests: RecordedRequest[];
    // 偽の RS に届いたリクエスト
    rsRequests: RecordedRequest[];
    // 偽の RS が持っているメモ(作った順)
    memos: Memo[];
    // 次から、/token が、この返事を返す(省略したら、普通の成功の返事に戻す)
    setTokenResponse: (
        response?: { status: number; body: unknown } | undefined,
    ) => void;
    // 次から、偽の RS が、全部のリクエストに、この status で答える(省略したら、普通に戻す)
    setRsFailure: (status?: number | undefined) => void;
    close: () => Promise<void>;
};

export async function startFakeBackends(): Promise<FakeBackends> {
    let tokenResponse: { status: number; body: unknown } | undefined;
    let rsFailure: number | undefined;
    let counter = 0;
    const memos: Memo[] = [];

    // 時刻は、呼ぶたびに、1 秒ずつ進める(並べ替えが、安定する)
    const timestamp = () =>
        new Date(Date.UTC(2026, 10, 1, 0, 0, counter++)).toISOString();

    const authServer: StubServer = await startStubServer(
        (request, response) => {
            if (request.method === 'POST' && request.url === '/token') {
                const { status, body } = tokenResponse ?? {
                    status: 200,
                    body: {
                        access_token: FAKE_ACCESS_TOKEN,
                        token_type: 'Bearer',
                        expires_in: 600,
                        scope: 'read write',
                    },
                };
                return sendJson(response, status, body, {
                    'Cache-Control': 'no-store',
                });
            }
            sendJson(response, 404, { error: 'not_found' });
        },
    );

    const resourceServer: StubServer = await startStubServer(
        (request, response) => {
            if (rsFailure !== undefined) {
                return sendJson(response, rsFailure, { error: 'failure' });
            }
            if (
                request.headers.authorization !== `Bearer ${FAKE_ACCESS_TOKEN}`
            ) {
                return sendJson(
                    response,
                    401,
                    { error: 'invalid_token' },
                    { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
                );
            }

            const match = /^\/memos(?:\/([^/?]+))?$/.exec(request.url);
            if (!match) return sendJson(response, 404, { error: 'not_found' });
            const id = match[1];
            const found = memos.find((memo) => memo.id === id);

            if (id === undefined) {
                if (request.method === 'GET')
                    return sendJson(response, 200, { memos });
                if (request.method === 'POST') {
                    const { body } = JSON.parse(request.body) as {
                        body: string;
                    };
                    const at = timestamp();
                    const memo: Memo = {
                        id: `m${memos.length + 1}`,
                        body,
                        createdAt: at,
                        updatedAt: at,
                    };
                    memos.push(memo);
                    return sendJson(response, 201, memo);
                }
            } else if (!found) {
                return sendJson(response, 404, { error: 'not_found' });
            } else if (request.method === 'GET') {
                return sendJson(response, 200, found);
            } else if (request.method === 'PUT') {
                const { body } = JSON.parse(request.body) as { body: string };
                found.body = body;
                found.updatedAt = timestamp();
                return sendJson(response, 200, found);
            } else if (request.method === 'DELETE') {
                memos.splice(memos.indexOf(found), 1);
                response.writeHead(204);
                response.end();
                return;
            }
            sendJson(response, 405, { error: 'method_not_allowed' });
        },
    );

    return {
        asBaseUrl: authServer.baseUrl,
        rsBaseUrl: resourceServer.baseUrl,
        tokenRequests: authServer.requests,
        rsRequests: resourceServer.requests,
        memos,
        setTokenResponse: (response) => {
            tokenResponse = response;
        },
        setRsFailure: (status) => {
            rsFailure = status;
        },
        close: async () => {
            await Promise.all([authServer.close(), resourceServer.close()]);
        },
    };
}
