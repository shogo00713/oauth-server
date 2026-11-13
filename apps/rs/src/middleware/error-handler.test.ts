import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startServer, type TestServer } from '../test-utils/http.js';
import { errorHandler, notFoundHandler } from './error-handler.js';

function createTestApp() {
    const app = express();
    app.use(express.json({ limit: '1kb' }));

    app.get('/throw', () => {
        throw new Error('SECRET-DETAIL');
    });
    app.get('/reject', async () => {
        throw new Error('SECRET-DETAIL');
    });
    app.get('/throw-string', () => {
        throw 'SECRET-DETAIL';
    });
    app.get('/status/:code', (req) => {
        const error = new Error('SECRET-DETAIL') as Error & {
            status?: number | string;
        };
        error.status = Number(req.params['code']);
        throw error;
    });
    // status が、数字ではなく、文字列("400")
    app.get('/status-string', () => {
        const error = new Error('SECRET-DETAIL') as Error & {
            status?: number | string;
        };
        error.status = '400';
        throw error;
    });
    app.post('/json', (req, res) => {
        res.json({ got: req.body ?? null });
    });

    app.use(notFoundHandler);
    app.use(errorHandler);
    return app;
}

let server: TestServer;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await startServer(createTestApp());
});

afterEach(async () => {
    await server.close();
    consoleError.mockRestore();
});

const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${server.baseUrl}${path}`, init);
    const text = await response.text();
    return {
        status: response.status,
        headers: response.headers,
        text,
        json: JSON.parse(text) as Record<string, unknown>,
    };
};

describe('ERROR-HANDLER エラーの返事(JSON)', () => {
    describe('notFoundHandler', () => {
        it('ルートが無い道は、404 の JSON', async () => {
            const result = await call('/nothing-here');

            expect(result.status).toBe(404);
            expect(result.headers.get('content-type')).toMatch(
                /^application\/json/,
            );
            expect(result.json).toEqual({ error: 'not_found' });
        });

        it('POST でも、404', async () => {
            const result = await call('/nothing-here', { method: 'POST' });

            expect(result.status).toBe(404);
        });

        it('道の名前を、返事に出さない', async () => {
            const result = await call('/secret-path-name');

            expect(result.text).not.toContain('secret-path-name');
        });
    });

    describe('errorHandler', () => {
        describe('想定してない例外(500)', () => {
            it.each(['/throw', '/reject', '/throw-string'])(
                '%s: 500 の JSON で、中身は返事に出さない',
                async (path) => {
                    const result = await call(path);

                    expect(result.status).toBe(500);
                    expect(result.headers.get('content-type')).toMatch(
                        /^application\/json/,
                    );
                    expect(result.json).toEqual({ error: 'server_error' });
                    expect(result.text).not.toContain('SECRET-DETAIL');
                },
            );

            it('ログには、例外をそのまま出す', async () => {
                await call('/throw');

                expect(consoleError).toHaveBeenCalledTimes(1);
                const [logged] = consoleError.mock.calls[0] ?? [];
                expect(logged).toBeInstanceOf(Error);
                expect((logged as Error).message).toBe('SECRET-DETAIL');
            });

            it('status が数字じゃない物(文字列の 400)は、500 として扱う', async () => {
                const result = await call('/status-string');

                expect(result.status).toBe(500);
            });
        });

        describe('4xx の status を持つ例外(クライアントの間違い)', () => {
            it.each([400, 403, 404, 413, 415, 499])(
                '%i: その status で、invalid_request(中身は出さない)',
                async (code) => {
                    const result = await call(`/status/${code}`);

                    expect(result.status).toBe(code);
                    expect(result.json).toEqual({ error: 'invalid_request' });
                    expect(result.text).not.toContain('SECRET-DETAIL');
                },
            );

            it('4xx は、ログに出さない', async () => {
                await call('/status/400');

                expect(consoleError).not.toHaveBeenCalled();
            });
        });

        describe('4xx 以外の status を持つ例外', () => {
            it.each([399, 500, 503, 600])(
                '%i: 500 として扱う',
                async (code) => {
                    const result = await call(`/status/${code}`);

                    expect(result.status).toBe(500);
                    expect(result.json).toEqual({ error: 'server_error' });
                },
            );

            it.each([500, 503])('%i: ログに出す', async (code) => {
                await call(`/status/${code}`);

                expect(consoleError).toHaveBeenCalledTimes(1);
            });
        });

        describe('本物の body-parser(express.json)の失敗', () => {
            const post = (body: string, contentType: string) =>
                call('/json', {
                    method: 'POST',
                    headers: { 'Content-Type': contentType },
                    body,
                });

            it('JSON が壊れている: 400', async () => {
                const result = await post('{bad', 'application/json');

                expect(result.status).toBe(400);
                expect(result.json).toEqual({ error: 'invalid_request' });
            });

            it('本文が大きすぎる: 413', async () => {
                const result = await post(
                    JSON.stringify({ body: 'a'.repeat(2000) }),
                    'application/json',
                );

                expect(result.status).toBe(413);
                expect(result.json).toEqual({ error: 'invalid_request' });
            });

            it('知らない文字コード: 415', async () => {
                const result = await post(
                    '{}',
                    'application/json; charset=foo',
                );

                expect(result.status).toBe(415);
            });

            it('正しい JSON なら、そのまま通る', async () => {
                const result = await post('{"body":"a"}', 'application/json');

                expect(result.status).toBe(200);
                expect(result.json).toEqual({ got: { body: 'a' } });
            });

            it('これらは、ログに出さない', async () => {
                await post('{bad', 'application/json');

                expect(consoleError).not.toHaveBeenCalled();
            });
        });
    });
});
