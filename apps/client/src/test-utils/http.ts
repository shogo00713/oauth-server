/**
 * ルートのテスト用の道具(テスト専用)
 * - app を、空いているポートで起動する
 * - ブラウザのように、Cookie を覚えて、リダイレクトを勝手に辿らないクライアント
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

export type TestResponse = {
    status: number;
    headers: Headers;
    text: string;
    // Location ヘッダー(無ければ null)
    location: string | null;
};

export type RequestOptions = {
    headers?: Record<string, string>;
};

export type TestClient = {
    // ブラウザの Cookie 入れ。名前 → 値(書き換えれば、改ざんの確認にも使える)
    cookies: Map<string, string>;
    get: (path: string, options?: RequestOptions) => Promise<TestResponse>;
    postForm: (
        path: string,
        body: Record<string, string>,
        options?: RequestOptions,
    ) => Promise<TestResponse>;
};

// Set-Cookie を読んで、入れ物に反映する(期限が過ぎた物、Max-Age が 0 以下の物は、消す)
const storeCookies = (cookies: Map<string, string>, headers: Headers) => {
    for (const line of headers.getSetCookie()) {
        const [pair = '', ...attributes] = line
            .split(';')
            .map((part) => part.trim());
        const separator = pair.indexOf('=');
        if (separator === -1) continue;

        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        const maxAge = attributes.find((a) => /^max-age=/i.test(a));
        const expires = attributes.find((a) => /^expires=/i.test(a));
        const isExpired =
            (maxAge !== undefined && Number(maxAge.slice(8)) <= 0) ||
            (expires !== undefined &&
                Date.parse(expires.slice(8)) <= Date.now());

        if (isExpired) cookies.delete(name);
        else cookies.set(name, value);
    }
};

export function createClient(baseUrl: string): TestClient {
    const cookies = new Map<string, string>();

    const request = async (
        path: string,
        init: {
            method: string;
            body?: string;
            headers: Record<string, string>;
        },
    ): Promise<TestResponse> => {
        const cookie = [...cookies]
            .map(([name, value]) => `${name}=${value}`)
            .join('; ');
        const response = await fetch(`${baseUrl}${path}`, {
            ...init,
            // リダイレクトは、勝手に辿らない(Location を見たいので)
            redirect: 'manual',
            headers: { ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
        });
        storeCookies(cookies, response.headers);
        return {
            status: response.status,
            headers: response.headers,
            text: await response.text(),
            location: response.headers.get('location'),
        };
    };

    return {
        cookies,
        get: (path, options) =>
            request(path, { method: 'GET', headers: options?.headers ?? {} }),
        postForm: (path, body, options) =>
            request(path, {
                method: 'POST',
                body: new URLSearchParams(body).toString(),
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    ...options?.headers,
                },
            }),
    };
}
