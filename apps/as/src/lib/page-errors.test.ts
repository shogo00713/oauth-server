import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createClient,
    startServer,
    type TestClient,
    type TestServer,
} from '../test-utils/http.js';
import { createPageTestApp } from '../test-utils/page-app.js';
import { sendErrorPage } from './page-errors.js';

const mount = (app: Express) => {
    app.get('/send', (req, res) => {
        sendErrorPage(
            res,
            Number(req.query['status']),
            String(req.query['message']),
        );
    });
    app.get('/throw', () => {
        throw new Error('SECRET-INTERNAL-DETAIL');
    });
    app.get('/reject', async () => {
        throw new Error('SECRET-INTERNAL-DETAIL');
    });
    app.get('/throw-string', () => {
        throw 'SECRET-INTERNAL-DETAIL';
    });
    app.get('/status/:code', (req, _res, next) => {
        next(
            Object.assign(new Error('SECRET-INTERNAL-DETAIL'), {
                status: Number(req.params['code']),
            }),
        );
    });
    app.get('/status-text', (_req, _res, next) => {
        next(
            Object.assign(new Error('SECRET-INTERNAL-DETAIL'), {
                status: '400',
            }),
        );
    });
};

let server: TestServer;
let client: TestClient;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    // 500 の時に、ログに出すので、テストの画面を汚さないように、止めておく(呼ばれたかは、見る)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startServer(createPageTestApp(mount));
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
});

// 中身(メッセージ、スタック、ファイルの場所)が、画面に出ていないこと
const expectNoLeak = (text: string) => {
    expect(text).not.toContain('SECRET-INTERNAL-DETAIL');
    expect(text).not.toContain('node_modules');
    expect(text).not.toMatch(/\.ts:\d+/);
};

describe('PAGE ERRORS エラー画面', () => {
    describe('sendErrorPage', () => {
        it.each([400, 403, 500])(
            'status が %d のエラー画面を返す',
            async (status) => {
                const response = await client.get(
                    `/send?status=${status}&message=hello`,
                );

                expect(response.status).toBe(status);
            },
        );

        it('HTML の画面で返す', async () => {
            const response = await client.get('/send?status=400&message=hello');

            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.text).toContain('<html');
        });

        it('メッセージを、画面に出す', async () => {
            const response = await client.get(
                `/send?status=400&message=${encodeURIComponent('見せたいメッセージ')}`,
            );

            expect(response.text).toContain('見せたいメッセージ');
        });

        it('メッセージの中の HTML は、エスケープして出す(タグとして働かせない)', async () => {
            const response = await client.get(
                `/send?status=400&message=${encodeURIComponent('<script>alert(1)</script>')}`,
            );

            expect(response.text).toContain(
                '&lt;script&gt;alert(1)&lt;/script&gt;',
            );
            expect(response.text).not.toContain('<script>');
        });
    });

    describe('notFoundHandler', () => {
        it('ルートが無い道は、404 のエラー画面', async () => {
            const response = await client.get('/nothing-here');

            expect(response.status).toBe(404);
            expect(response.headers.get('content-type')).toMatch(/^text\/html/);
            expect(response.text).toContain('<html');
        });

        it('POST でも、404 のエラー画面', async () => {
            const response = await client.postForm('/nothing-here', { a: 'b' });

            expect(response.status).toBe(404);
            expect(response.text).toContain('<html');
        });

        it('道の名前を、画面に出さない', async () => {
            const response = await client.get('/nothing-here-<b>x</b>');

            expect(response.text).not.toContain('nothing-here');
        });
    });

    describe('pageErrorHandler', () => {
        describe('想定してない例外(500)', () => {
            it.each(['/throw', '/reject', '/throw-string'])(
                '500 のエラー画面を返して、中身は出さない: %s',
                async (path) => {
                    const response = await client.get(path);

                    expect(response.status).toBe(500);
                    expect(response.headers.get('content-type')).toMatch(
                        /^text\/html/,
                    );
                    expect(response.text).toContain('<html');
                    expectNoLeak(response.text);
                },
            );

            it('ログには、例外をそのまま出す', async () => {
                await client.get('/throw');

                expect(consoleError).toHaveBeenCalledOnce();
                expect(String(consoleError.mock.calls[0]?.[0])).toContain(
                    'SECRET-INTERNAL-DETAIL',
                );
            });

            it('status が数字じゃない物(文字列の 400)は、500 として扱う', async () => {
                const response = await client.get('/status-text');

                expect(response.status).toBe(500);
                expectNoLeak(response.text);
            });
        });

        describe('4xx の status を持つ例外(クライアントの間違い)', () => {
            it.each([400, 403, 404, 413, 499])(
                'status が %d なら、そのまま %d のエラー画面で、中身は出さない',
                async (status) => {
                    const response = await client.get(`/status/${status}`);

                    expect(response.status).toBe(status);
                    expect(response.headers.get('content-type')).toMatch(
                        /^text\/html/,
                    );
                    expectNoLeak(response.text);
                },
            );

            it('4xx は、ログに出さない', async () => {
                await client.get('/status/400');
                await client.get('/status/499');

                expect(consoleError).not.toHaveBeenCalled();
            });
        });

        describe('4xx 以外の status を持つ例外', () => {
            it.each([399, 500, 503, 600])(
                'status が %d なら、500 のエラー画面',
                async (status) => {
                    const response = await client.get(`/status/${status}`);

                    expect(response.status).toBe(500);
                    expectNoLeak(response.text);
                },
            );

            it.each([500, 503])(
                'status が %d の例外は、ログに出す',
                async (status) => {
                    await client.get(`/status/${status}`);

                    expect(consoleError).toHaveBeenCalledOnce();
                },
            );
        });
    });
});
