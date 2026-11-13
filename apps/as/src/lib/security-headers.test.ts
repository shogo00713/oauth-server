import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    createClient,
    startServer,
    type TestClient,
    type TestServer,
} from '../test-utils/http.js';
import { noStore, securityHeaders } from './security-headers.js';

// CSP を、「名前 → 値」にばらす(例: "default-src 'self'" → ['default-src', "'self'"])
const parseCsp = (value: string | null): Map<string, string> =>
    new Map(
        (value ?? '')
            .split(';')
            .map((directive) => directive.trim())
            .filter((directive) => directive !== '')
            .map((directive) => {
                const [name = '', ...rest] = directive.split(/\s+/);
                return [name, rest.join(' ')] as const;
            }),
    );

let server: TestServer;
let client: TestClient;

beforeEach(async () => {
    const app = express();
    app.use(securityHeaders());
    app.get('/page', noStore, (_req, res) => {
        res.type('html').send('<p>hello</p>');
    });
    app.get('/plain', (_req, res) => {
        res.type('text').send('plain');
    });
    server = await startServer(app);
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
});

describe('SECURITY HEADERS セキュリティ用のヘッダー RFC 9700 4.16', () => {
    describe('securityHeaders', () => {
        describe('クリックジャッキング対策(RFC 9700 4.16: AS は防がなければならない)', () => {
            it.each(['/page', '/plain'])(
                'X-Frame-Options は DENY: %s',
                async (path) => {
                    const response = await client.get(path);

                    expect(response.headers.get('x-frame-options')).toBe(
                        'DENY',
                    );
                },
            );

            it('CSP の frame-ancestors は none', async () => {
                const response = await client.get('/page');
                const csp = parseCsp(
                    response.headers.get('content-security-policy'),
                );

                expect(csp.get('frame-ancestors')).toBe("'none'");
            });

            it('ルートが無い(404)ページにも、X-Frame-Options は付く', async () => {
                const response = await client.get('/nothing');

                expect(response.status).toBe(404);
                expect(response.headers.get('x-frame-options')).toBe('DENY');
            });
        });

        describe('CSP のそのほか', () => {
            it('form-action は付けない(付けると、同意の後の、クライアントへのリダイレクトを、ブラウザが止める)', async () => {
                const response = await client.get('/page');
                const csp = parseCsp(
                    response.headers.get('content-security-policy'),
                );

                // 比べるために、CSP 自体は付いていること
                expect(csp.has('frame-ancestors')).toBe(true);
                expect(csp.has('form-action')).toBe(false);
            });

            it('upgrade-insecure-requests は付けない(開発は http で動かすので)', async () => {
                const response = await client.get('/page');
                const csp = parseCsp(
                    response.headers.get('content-security-policy'),
                );

                expect(csp.has('frame-ancestors')).toBe(true);
                expect(csp.has('upgrade-insecure-requests')).toBe(false);
            });

            it.each([
                { directive: 'default-src', value: "'self'" },
                { directive: 'script-src', value: "'self'" },
                { directive: 'object-src', value: "'none'" },
            ])(
                '$directive は $value(ほかのオリジンの、スクリプトなどは、読み込まない)',
                async ({ directive, value }) => {
                    const response = await client.get('/page');
                    const csp = parseCsp(
                        response.headers.get('content-security-policy'),
                    );

                    expect(csp.get(directive)).toBe(value);
                },
            );
        });

        describe('そのほかのヘッダー', () => {
            it('X-Content-Type-Options は nosniff', async () => {
                const response = await client.get('/page');

                expect(response.headers.get('x-content-type-options')).toBe(
                    'nosniff',
                );
            });

            it('Referrer-Policy は no-referrer(URL の中の、code や state を、リンク先に漏らさない)', async () => {
                const response = await client.get('/page');

                expect(response.headers.get('referrer-policy')).toBe(
                    'no-referrer',
                );
            });

            it('X-Powered-By は出さない(Express だと教えない)', async () => {
                const response = await client.get('/page');

                expect(response.headers.has('x-powered-by')).toBe(false);
            });

            it('Cache-Control には触らない(付けるかは、道ごとに決める)', async () => {
                const response = await client.get('/plain');

                expect(response.headers.has('cache-control')).toBe(false);
            });
        });
    });

    describe('noStore', () => {
        it('Cache-Control: no-store と、Pragma: no-cache を付ける', async () => {
            const response = await client.get('/page');

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('付けた道の、中身は、そのまま返る(次の処理に進む)', async () => {
            const response = await client.get('/page');

            expect(response.status).toBe(200);
            expect(response.text).toBe('<p>hello</p>');
        });

        it('付けてない道には、付かない', async () => {
            const response = await client.get('/plain');

            expect(response.headers.has('pragma')).toBe(false);
        });
    });
});
