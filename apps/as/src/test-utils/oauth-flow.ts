/**
 * 認可コードの流れを、ブラウザとアプリの代わりに進める道具(テスト専用)
 *   authorizeInBrowser: /authorize から、ログイン、同意まで進んで、アプリに戻る URL を返す
 *   exchangeCode: 認可コードを、アクセストークンに引き換える(/token)
 */
import { expect } from 'vitest';
import type { TestClient } from './http.js';

export type AuthorizeParams = {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope?: string | undefined;
    state?: string | undefined;
};

export type Credentials = {
    username: string;
    password: string;
};

// 画面の HTML から、フォームの CSRF トークンを取り出す
const csrfOf = (html: string): string =>
    /<input[^>]*name="_csrf"[^>]*value="([^"]*)"/.exec(html)?.[1] ?? '';

// ブラウザの代わりに、/authorize から同意まで進んで、最後に、アプリへ戻る URL(Location)を返す
// (すでにログイン済みなら、ログインの画面は飛ばす)
export async function authorizeInBrowser(
    browser: TestClient,
    params: AuthorizeParams,
    credentials: Credentials,
    decision: 'allow' | 'deny' = 'allow',
): Promise<URL> {
    const query = new URLSearchParams({
        response_type: 'code',
        client_id: params.clientId,
        redirect_uri: params.redirectUri,
        code_challenge: params.codeChallenge,
        code_challenge_method: 'S256',
    });
    if (params.scope !== undefined) query.set('scope', params.scope);
    if (params.state !== undefined) query.set('state', params.state);

    // 1. 認可リクエスト
    let response = await browser.get(`/authorize?${query.toString()}`);
    expect(response.status).toBe(303);

    // 2. ログイン(まだなら)
    if (response.location === '/login') {
        response = await browser.get('/login');
        expect(response.status).toBe(200);
        response = await browser.postForm('/login', {
            username: credentials.username,
            password: credentials.password,
            _csrf: csrfOf(response.text),
        });
        expect(response.status).toBe(303);
    }

    // 3. 同意
    expect(response.location).toBe('/consent');
    response = await browser.get('/consent');
    expect(response.status).toBe(200);
    response = await browser.postForm('/consent', {
        decision,
        _csrf: csrfOf(response.text),
    });
    expect(response.status).toBe(303);

    return new URL(response.location ?? '');
}

export type TokenResult = {
    status: number;
    headers: Headers;
    json: Record<string, unknown>;
};

// 認可コードを、アクセストークンに引き換える(アプリのサーバーが、やること)
export async function exchangeCode(
    baseUrl: string,
    params: {
        clientId: string;
        clientSecret: string;
        code: string;
        redirectUri: string;
        codeVerifier: string;
    },
): Promise<TokenResult> {
    const response = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: params.code,
            redirect_uri: params.redirectUri,
            code_verifier: params.codeVerifier,
        }),
    });
    return {
        status: response.status,
        headers: response.headers,
        json: (await response.json()) as Record<string, unknown>,
    };
}
