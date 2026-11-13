import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer, type TestServer } from '../test-utils/http.js';
import { noStore } from './no-store.js';

let server: TestServer;

beforeEach(async () => {
    const app = express();
    app.use(noStore);
    app.get('/ok', (_req, res) => {
        res.json({ ok: true });
    });
    app.get('/fail', (_req, res) => {
        res.status(500).json({ ok: false });
    });
    server = await startServer(app);
});

afterEach(async () => {
    await server.close();
});

describe('NO-STORE キャッシュさせない', () => {
    it('Cache-Control: no-store を付ける', async () => {
        const response = await fetch(`${server.baseUrl}/ok`);

        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('エラーの返事にも、付く', async () => {
        const response = await fetch(`${server.baseUrl}/fail`);

        expect(response.status).toBe(500);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});
