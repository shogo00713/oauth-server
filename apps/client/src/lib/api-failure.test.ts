import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiFailure } from '../rs/memo-api.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestServer,
} from '../test-utils/http.js';
import { createPageTestApp, readSession } from '../test-utils/page-app.js';
import { describeApiFailure, respondWithFailure } from './api-failure.js';
import { ensureCsrfToken } from './csrf.js';
import { SESSION_COOKIE_NAME } from './session.js';

const FAILURES: ApiFailure[] = [
    'unauthorized',
    'insufficient_scope',
    'forbidden',
    'not_found',
    'invalid_request',
    'unavailable',
];

const PAGE_FAILURES = [
    { failure: 'insufficient_scope', status: 403 },
    { failure: 'forbidden', status: 403 },
    { failure: 'not_found', status: 404 },
    { failure: 'invalid_request', status: 400 },
    { failure: 'unavailable', status: 502 },
] as const;

let server: TestServer;
let client: TestClient;

beforeEach(async () => {
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: CSRF トークンを作る(フォームを開いたことにする)
            app.get('/__csrf', (req, res) => {
                res.send(ensureCsrfToken(req.session));
            });
            app.get('/__fail/:kind', async (req, res) => {
                await respondWithFailure(
                    req,
                    res,
                    req.params['kind'] as ApiFailure,
                );
            });
        }),
    );
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
});

// エラー画面の、メッセージの文字
const messageOf = (html: string) =>
    /id="message"[^>]*>([^<]*)</.exec(html)?.[1] ?? '';

describe('API FAILURE RS を呼んで失敗した時の、画面の動き', () => {
    describe('describeApiFailure', () => {
        it('unauthorized(401)だけが、再ログイン', () => {
            expect(describeApiFailure('unauthorized')).toEqual({
                kind: 'relogin',
            });
            for (const failure of FAILURES.filter((f) => f !== 'unauthorized'))
                expect(describeApiFailure(failure).kind).toBe('page');
        });

        it.each(PAGE_FAILURES)(
            '$failure は、$status のエラー画面',
            ({ failure, status }) => {
                const response = describeApiFailure(failure);

                expect(response).toMatchObject({ kind: 'page', status });
            },
        );

        it.each(PAGE_FAILURES)(
            '$failure の言葉は、空じゃない',
            ({ failure }) => {
                const response = describeApiFailure(failure);

                expect(
                    response.kind === 'page' ? response.message : '',
                ).not.toBe('');
            },
        );

        it('権限不足(insufficient_scope)と、許可されていない(forbidden)は、違う言葉', () => {
            const scope = describeApiFailure('insufficient_scope');
            const forbidden = describeApiFailure('forbidden');

            expect(scope.kind === 'page' ? scope.message : '').not.toBe(
                forbidden.kind === 'page' ? forbidden.message : '',
            );
        });
    });

    describe('respondWithFailure', () => {
        describe('unauthorized: セッションを捨てて、トップへ', () => {
            it('/ へ 303', async () => {
                await client.get('/__test/login');

                const response = await client.get('/__fail/unauthorized');

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
            });

            it('セッションは、空になる(トークンも、CSRF トークンも)。メッセージだけ入る', async () => {
                await client.get('/__test/login');
                await client.get('/__csrf');
                // 比べるために、捨てる前は、ログインしていて、CSRF トークンもあること
                const before = await readSession(client);
                expect(before.tokens).not.toBeNull();
                expect(before.csrfToken).not.toBeNull();

                await client.get('/__fail/unauthorized');
                const session = await readSession(client);

                expect(session.tokens).toBeNull();
                expect(session.csrfToken).toBeNull();
                expect(typeof session.flash).toBe('string');
                expect(session.flash).not.toBe('');
            });

            it('セッション ID が変わって、古い ID は、もう使えない', async () => {
                await client.get('/__test/login');
                const oldCookie = client.cookies.get(SESSION_COOKIE_NAME) ?? '';

                await client.get('/__fail/unauthorized');

                expect(client.cookies.get(SESSION_COOKIE_NAME)).not.toBe(
                    oldCookie,
                );
                const old = createClient(server.baseUrl);
                old.cookies.set(SESSION_COOKIE_NAME, oldCookie);
                expect((await readSession(old)).tokens).toBeNull();
            });

            it('セッションを持っていない人でも、/ へ 303', async () => {
                const response = await client.get('/__fail/unauthorized');

                expect(response.status).toBe(303);
                expect(response.location).toBe('/');
            });
        });

        describe('それ以外: エラー画面', () => {
            it.each(PAGE_FAILURES)(
                '$failure は、$status のエラー画面(HTML。リダイレクトではない)',
                async ({ failure, status }) => {
                    const response = await client.get(`/__fail/${failure}`);

                    expect(response.status).toBe(status);
                    expect(response.headers.get('content-type')).toMatch(
                        /^text\/html/,
                    );
                    expect(response.text).toContain('<html');
                    expect(response.location).toBeNull();
                },
            );

            it.each(PAGE_FAILURES)(
                '$failure では、ログインは、そのまま(セッションを捨てない)',
                async ({ failure }) => {
                    await client.get('/__test/login');
                    const cookie = client.cookies.get(SESSION_COOKIE_NAME);

                    await client.get(`/__fail/${failure}`);

                    expect((await readSession(client)).tokens).not.toBeNull();
                    expect(client.cookies.get(SESSION_COOKIE_NAME)).toBe(
                        cookie,
                    );
                },
            );

            it('画面の言葉は、describeApiFailure の言葉と同じ', async () => {
                for (const { failure } of PAGE_FAILURES) {
                    const response = await client.get(`/__fail/${failure}`);
                    const expected = describeApiFailure(failure);

                    expect(messageOf(response.text)).toBe(
                        expected.kind === 'page' ? expected.message : '',
                    );
                }
            });

            it('権限不足と、許可されていないは、画面の言葉も違う', async () => {
                const scope = await client.get('/__fail/insufficient_scope');
                const forbidden = await client.get('/__fail/forbidden');

                expect(messageOf(scope.text)).not.toBe('');
                expect(messageOf(scope.text)).not.toBe(
                    messageOf(forbidden.text),
                );
            });
        });
    });
});
