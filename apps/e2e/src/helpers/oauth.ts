/**
 * OAuth の client の代わり(結合テスト用)
 *   AS を、直接たたく。client(メモボード)を通さずに、AS と RS の約束を、細かく確かめるため
 *   登録済みの client_id と client_secret は、テストが作った物(Stack が持っている)
 */
import { createHash, randomBytes } from 'node:crypto';
import { Browser, csrfOf, type Page } from './browser.js';
import type { Json } from './jwt.js';
import type { Stack } from './stack.js';

export const pkcePair = () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
};

export type Params = Record<string, string | undefined>;

// 正しい認可リクエストのパラメータ。上書きしたい物だけ、extra に書く(undefined を入れると、その項目を消す)
export function authorizeParams(
    stack: Stack,
    challenge: string,
    extra: Params = {},
): Params {
    return {
        response_type: 'code',
        client_id: stack.clientId,
        redirect_uri: stack.redirectUri,
        scope: 'read write',
        state: randomBytes(16).toString('base64url'),
        code_challenge: challenge,
        code_challenge_method: 'S256',
        ...extra,
    };
}

export function authorizeUrl(stack: Stack, params: Params): string {
    const url = new URL('/authorize', stack.as.baseUrl);
    for (const [name, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(name, value);
    }
    return url.toString();
}

/**
 * 認可リクエストを送って、ログイン、同意まで進める(AS の中のリダイレクトだけ追う)
 * @returns client に戻す、最初のリダイレクト(追わない。Location に、戻り先が入る)。
 *   エラー画面が出た時は、その画面
 */
export async function authorize(
    stack: Stack,
    browser: Browser,
    params: Params,
    decision: 'allow' | 'deny' = 'allow',
): Promise<Page> {
    const withinAs = (next: string) => next.startsWith(`${stack.as.baseUrl}/`);

    let page = await browser.send(authorizeUrl(stack, params), {
        follow: withinAs,
    });
    if (page.text.includes('name="username"')) {
        page = await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(page.text),
                username: stack.username,
                password: stack.password,
            },
            follow: withinAs,
        });
    }
    if (page.text.includes('action="/consent"')) {
        page = await browser.send(`${stack.as.baseUrl}/consent`, {
            form: { _csrf: csrfOf(page.text), decision },
            follow: withinAs,
        });
    }
    return page;
}

// 戻り先(client の /callback)の URL に付いている、パラメータ
export function callbackParams(page: Page): URLSearchParams {
    if (!page.location) throw new Error('リダイレクトではありません');
    return new URL(page.location).searchParams;
}

export type TokenResponse = {
    status: number;
    headers: Headers;
    json: Json;
};

export type ExchangeOptions = {
    code: string;
    verifier: string;
    redirectUri?: string;
    // クライアント認証(Authorization: Basic)。false なら、付けない
    basic?: { id: string; secret: string } | false;
    // フォームの項目を、足す、または、消す(undefined)
    form?: Params;
};

// トークンエンドポイントを、たたく
export async function exchangeCode(
    stack: Stack,
    options: ExchangeOptions,
): Promise<TokenResponse> {
    const basic = options.basic ?? {
        id: stack.clientId,
        secret: stack.clientSecret,
    };
    const form: Params = {
        grant_type: 'authorization_code',
        code: options.code,
        redirect_uri: options.redirectUri ?? stack.redirectUri,
        code_verifier: options.verifier,
        ...options.form,
    };
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(form)) {
        if (value !== undefined) body.set(name, value);
    }

    const headers = new Headers({
        'Content-Type': 'application/x-www-form-urlencoded',
    });
    if (basic) {
        headers.set(
            'Authorization',
            `Basic ${Buffer.from(`${basic.id}:${basic.secret}`).toString('base64')}`,
        );
    }

    const response = await fetch(`${stack.as.baseUrl}/token`, {
        method: 'POST',
        headers,
        body: body.toString(),
    });
    return {
        status: response.status,
        headers: response.headers,
        json: (await response.json()) as Json,
    };
}

export type Issued = {
    accessToken: string;
    response: TokenResponse;
    code: string;
    state: string;
    verifier: string;
};

// 認可コードグラントを、最後まで通して、アクセストークンをもらう(client の代わり)
export async function obtainToken(
    stack: Stack,
    options: { browser?: Browser; scope?: string } = {},
): Promise<Issued> {
    const browser = options.browser ?? new Browser();
    const { verifier, challenge } = pkcePair();
    const params = authorizeParams(
        stack,
        challenge,
        options.scope === undefined ? {} : { scope: options.scope },
    );

    const page = await authorize(stack, browser, params);
    const query = callbackParams(page);
    const code = query.get('code');
    const state = query.get('state');
    if (!code || !state) {
        throw new Error(`認可コードが戻りませんでした: ${page.location}`);
    }
    const response = await exchangeCode(stack, { code, verifier });
    const accessToken = response.json['access_token'];
    if (typeof accessToken !== 'string') {
        throw new Error(
            `アクセストークンが出ませんでした: ${JSON.stringify(response.json)}`,
        );
    }
    return { accessToken, response, code, state, verifier };
}

// ---- RS の API ----

export type MemoJson = {
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
};

export type RsResponse = {
    status: number;
    headers: Headers;
    text: string;
    json: unknown;
};

export async function callRs(
    stack: Stack,
    options: {
        token?: string | undefined;
        method?: string;
        path?: string;
        // JSON として送る物
        json?: unknown;
        // そのまま送る文字列(壊れた JSON を送りたい時)
        raw?: string;
        headers?: Record<string, string>;
    } = {},
): Promise<RsResponse> {
    const headers = new Headers(options.headers);
    if (options.token !== undefined) {
        headers.set('Authorization', `Bearer ${options.token}`);
    }
    const request: RequestInit = { method: options.method ?? 'GET', headers };
    if (options.raw !== undefined) {
        headers.set('Content-Type', 'application/json');
        request.body = options.raw;
    } else if (options.json !== undefined) {
        headers.set('Content-Type', 'application/json');
        request.body = JSON.stringify(options.json);
    }

    const response = await fetch(
        `${stack.rs.baseUrl}${options.path ?? '/memos'}`,
        request,
    );
    const text = await response.text();
    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json };
}

// ---- client(メモボード)を通した、ログイン ----

/**
 * ブラウザで、client の「ログイン」から始めて、メモ一覧が出るところまで進める
 * @returns 最後の画面(client のメモ一覧)
 */
export async function loginThroughClient(
    stack: Stack,
    browser: Browser,
): Promise<Page> {
    let page = await browser.send(`${stack.client.baseUrl}/login`);
    page = await browser.send(`${stack.as.baseUrl}/login`, {
        form: {
            _csrf: csrfOf(page.text),
            username: stack.username,
            password: stack.password,
        },
    });
    return browser.send(`${stack.as.baseUrl}/consent`, {
        form: { _csrf: csrfOf(page.text), decision: 'allow' },
    });
}
