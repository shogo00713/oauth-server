/**
 * M1 の完了条件: AS(docs/milestones/m1.md の「AS」と、「全体」の JWT の所)
 *   - JWT 形式のアクセストークン(RS256、直置きの鍵)
 *   - PKCE
 *   - クライアント認証
 *   - ログインとそのセッション(インメモリ)
 *   - argon2 を使ったパスワードのハッシュ(ログインの成否として、外から確かめる)
 * 本物の AS を起動して、client の代わり(helpers/oauth.ts)で、直接たたく
 */
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser, csrfOf, errorMessageOf } from './helpers/browser.js';
import { decodeJwt, verifyRs256 } from './helpers/jwt.js';
import {
    authorize,
    authorizeParams,
    authorizeUrl,
    callbackParams,
    exchangeCode,
    obtainToken,
    pkcePair,
    type ExchangeOptions,
} from './helpers/oauth.js';
import { startStack, type Stack } from './helpers/stack.js';

let stack: Stack;

beforeAll(async () => {
    stack = await startStack();
});

afterAll(async () => {
    await stack.stop();
});

// 認可コードを 1 つ、もらう(まだ、トークンには引き換えない)
async function freshCode(extra: Record<string, string | undefined> = {}) {
    const { verifier, challenge } = pkcePair();
    const page = await authorize(
        stack,
        new Browser(),
        authorizeParams(stack, challenge, extra),
    );
    const code = callbackParams(page).get('code');
    if (!code)
        throw new Error(`認可コードが戻りませんでした: ${page.location}`);
    return { code, verifier };
}

describe('M1-AS アクセストークン(JWT、RS256、直置きの鍵)', () => {
    it('JWT で、ヘッダーは RS256 と at+jwt。AS の公開鍵(PEM)で署名を確かめられる。別の鍵では、確かめられない', async () => {
        const { accessToken } = await obtainToken(stack);

        const { header } = decodeJwt(accessToken);

        expect(header['alg']).toBe('RS256');
        expect(header['typ']).toBe('at+jwt');
        expect(typeof header['kid']).toBe('string');
        expect(verifyRs256(accessToken, stack.publicKeyPem)).toBe(true);
        const other = generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        });
        expect(verifyRs256(accessToken, other.publicKey)).toBe(false);
    });

    it('クレーム: iss、aud、sub、client_id、scope、iat、exp(10 分後)、jti', async () => {
        const { accessToken } = await obtainToken(stack);

        const { payload } = decodeJwt(accessToken);

        expect(Object.keys(payload).sort()).toEqual([
            'aud',
            'client_id',
            'exp',
            'iat',
            'iss',
            'jti',
            'scope',
            'sub',
        ]);
        expect(payload['iss']).toBe(stack.issuer);
        expect(payload['aud']).toBe('simple-memo');
        expect(payload['client_id']).toBe(stack.clientId);
        expect(payload['scope']).toBe('read write');
        expect(typeof payload['sub']).toBe('string');
        expect(payload['sub']).not.toBe('');
        expect((payload['exp'] as number) - (payload['iat'] as number)).toBe(
            600,
        );
        expect(payload['iat']).toBeGreaterThan(Date.now() / 1000 - 60);
    });

    it('同じ人が 2 回もらうと、sub は同じで、jti は違う', async () => {
        const first = decodeJwt((await obtainToken(stack)).accessToken);
        const second = decodeJwt((await obtainToken(stack)).accessToken);

        expect(second.payload['sub']).toBe(first.payload['sub']);
        expect(second.payload['jti']).not.toBe(first.payload['jti']);
    });

    it('トークンの中に、パスワードや、client の秘密は、入っていない', async () => {
        const { accessToken } = await obtainToken(stack);

        const { payload } = decodeJwt(accessToken);

        const text = JSON.stringify(payload);
        expect(text).not.toContain(stack.password);
        expect(text).not.toContain(stack.clientSecret);
    });

    it('レスポンス: token_type=Bearer、expires_in=600、scope。キャッシュさせない', async () => {
        const { response } = await obtainToken(stack);

        expect(response.status).toBe(200);
        expect(response.json).toMatchObject({
            token_type: 'Bearer',
            expires_in: 600,
            scope: 'read write',
        });
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('pragma')).toBe('no-cache');
    });
});

describe('M1-AS PKCE', () => {
    it('code_verifier が違うと、invalid_grant(400)。そのコードは、もう使えない(正しい verifier でも)', async () => {
        const { verifier, challenge } = pkcePair();
        const page = await authorize(
            stack,
            new Browser(),
            authorizeParams(stack, challenge),
        );
        const code = callbackParams(page).get('code') ?? '';

        const wrong = await exchangeCode(stack, {
            code,
            verifier: pkcePair().verifier,
        });
        const retry = await exchangeCode(stack, { code, verifier });

        expect(wrong.status).toBe(400);
        expect(wrong.json).toMatchObject({ error: 'invalid_grant' });
        expect(retry.status).toBe(400);
        expect(retry.json).toMatchObject({ error: 'invalid_grant' });
    });

    it('code_verifier を付けないトークンリクエストは、断られる', async () => {
        const { code, verifier } = await freshCode();

        const response = await exchangeCode(stack, {
            code,
            verifier,
            form: { code_verifier: undefined },
        });

        expect(response.status).toBe(400);
        expect(['invalid_request', 'invalid_grant']).toContain(
            response.json['error'],
        );
    });

    it.each([
        { name: 'code_challenge が無い', extra: { code_challenge: undefined } },
        {
            name: 'code_challenge_method が plain(S256 だけ使える)',
            extra: { code_challenge_method: 'plain' },
        },
        {
            name: 'code_challenge_method が無い',
            extra: { code_challenge_method: undefined },
        },
        { name: 'code_challenge が短すぎる', extra: { code_challenge: 'abc' } },
        {
            name: 'code_challenge に、使えない文字がある',
            extra: { code_challenge: `${'a'.repeat(42)}!` },
        },
    ])(
        '認可リクエストの、$name は、client に error=invalid_request(と state)で戻される',
        async ({ extra }) => {
            const { challenge } = pkcePair();
            const params = authorizeParams(stack, challenge, extra);

            const page = await authorize(stack, new Browser(), params);

            expect(page.status).toBe(303);
            const query = callbackParams(page);
            expect(page.location?.startsWith(stack.redirectUri)).toBe(true);
            expect(query.get('error')).toBe('invalid_request');
            expect(query.get('state')).toBe(params['state']);
            expect(query.has('code')).toBe(false);
        },
    );
});

describe('M1-AS クライアント認証', () => {
    const wrongSecret = (s: Stack) => ({
        id: s.clientId,
        secret: `${s.clientSecret.slice(1)}x`,
    });

    it.each<{
        name: string;
        options: (s: Stack) => Partial<ExchangeOptions>;
    }>([
        {
            name: 'Authorization ヘッダーが無い',
            options: () => ({ basic: false }),
        },
        {
            name: '秘密が違う',
            options: (s) => ({ basic: wrongSecret(s) }),
        },
        {
            name: 'client_id が違う',
            options: (s) => ({
                basic: { id: 'unknown', secret: s.clientSecret },
            }),
        },
        {
            name: '秘密を、フォームの項目で送っている(Basic だけ使える)',
            options: (s) => ({
                basic: false,
                form: { client_id: s.clientId, client_secret: s.clientSecret },
            }),
        },
    ])('$name と、401 invalid_client', async ({ options }) => {
        const { code, verifier } = await freshCode();

        const response = await exchangeCode(stack, {
            code,
            verifier,
            ...options(stack),
        });

        expect(response.status).toBe(401);
        expect(response.json).toMatchObject({ error: 'invalid_client' });
        expect(response.json).not.toHaveProperty('access_token');
    });
});

describe('M1-AS 認可コード', () => {
    it('同じ認可コードは、2 回目は使えない(invalid_grant)', async () => {
        const { code, verifier } = await freshCode();

        const first = await exchangeCode(stack, { code, verifier });
        const second = await exchangeCode(stack, { code, verifier });

        expect(first.status).toBe(200);
        expect(second.status).toBe(400);
        expect(second.json).toMatchObject({ error: 'invalid_grant' });
        expect(second.json).not.toHaveProperty('access_token');
    });

    it('認可リクエストの時と、違う redirect_uri では、引き換えられない(invalid_grant)', async () => {
        const { code, verifier } = await freshCode();

        const response = await exchangeCode(stack, {
            code,
            verifier,
            redirectUri: `${stack.redirectUri}?x=1`,
        });

        expect(response.status).toBe(400);
        expect(response.json).toMatchObject({ error: 'invalid_grant' });
    });

    it('でたらめなコードは、invalid_grant', async () => {
        const response = await exchangeCode(stack, {
            code: 'not-a-code',
            verifier: pkcePair().verifier,
        });

        expect(response.status).toBe(400);
        expect(response.json).toMatchObject({ error: 'invalid_grant' });
    });
});

describe('M1-AS リダイレクト URL(オープンリダイレクト対策)', () => {
    it.each([
        { name: '別のサイト', uri: () => 'https://evil.example/callback' },
        {
            name: '登録された物の、後ろに、道を足した',
            uri: () => `${stack.redirectUri}/..`,
        },
        {
            name: '登録された物に、クエリを足した',
            uri: () => `${stack.redirectUri}?next=https://evil.example`,
        },
        {
            name: '登録された物に、フラグメントを足した',
            uri: () => `${stack.redirectUri}#x`,
        },
        {
            name: '登録された物の、末尾に / を足した',
            uri: () => `${stack.redirectUri}/`,
        },
        {
            name: 'ホスト名を、IP アドレスに変えた',
            uri: () => stack.redirectUri.replace('localhost', '127.0.0.1'),
        },
        { name: '空', uri: () => '' },
    ])(
        '戻り先が「$name」だと、リダイレクトせずに、エラー画面(400)',
        async ({ uri }) => {
            const { challenge } = pkcePair();
            const params = authorizeParams(stack, challenge, {
                redirect_uri: uri(),
            });

            const page = await new Browser().send(authorizeUrl(stack, params), {
                follow: false,
            });

            expect(page.status).toBe(400);
            expect(page.location).toBeNull();
            expect(errorMessageOf(page.text)).toContain('redirect_uri');
        },
    );

    it('client_id が、登録されていない物なら、リダイレクトせずに、エラー画面(400)', async () => {
        const { challenge } = pkcePair();
        const params = authorizeParams(stack, challenge, {
            client_id: 'unknown-client',
        });

        const page = await new Browser().send(authorizeUrl(stack, params), {
            follow: false,
        });

        expect(page.status).toBe(400);
        expect(page.location).toBeNull();
        expect(errorMessageOf(page.text)).toContain('client_id');
    });
});

describe('M1-AS ログインとそのセッション(インメモリ)', () => {
    const toLogin = async (browser: Browser) => {
        const { challenge } = pkcePair();
        return browser.get(
            authorizeUrl(stack, authorizeParams(stack, challenge)),
        );
    };

    it('パスワードが違うと、ログイン画面に戻る。同意には進めない。ユーザー名が違う時も、同じ言葉', async () => {
        const browser = new Browser();
        const login = await toLogin(browser);
        const wrongPassword = await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(login.text),
                username: stack.username,
                password: `${stack.password}x`,
            },
        });
        const wrongUser = await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(wrongPassword.text),
                username: 'nobody',
                password: stack.password,
            },
        });

        for (const page of [wrongPassword, wrongUser]) {
            expect(page.status).toBe(200);
            expect(page.text).toContain('ユーザー名かパスワードが違います');
            expect(page.text).toContain('name="username"');
        }
        // ログインできていないので、同意の画面は出ない(ログインへ戻される)
        const consent = await browser.get(`${stack.as.baseUrl}/consent`);
        expect(consent.url).toBe(`${stack.as.baseUrl}/login`);
        // 正しいパスワードなら、進める(同じブラウザ、同じ認可リクエストで)
        const ok = await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(wrongUser.text),
                username: stack.username,
                password: stack.password,
            },
        });
        expect(ok.url).toBe(`${stack.as.baseUrl}/consent`);
    });

    it('ログインすると、セッション ID が作り直される(固定化攻撃への対策)', async () => {
        const browser = new Browser();
        const login = await toLogin(browser);
        const before = browser.cookie(stack.as.baseUrl, 'as_sid');

        await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(login.text),
                username: stack.username,
                password: stack.password,
            },
        });
        const after = browser.cookie(stack.as.baseUrl, 'as_sid');

        expect(before).toBeDefined();
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
    });

    it('セッションの Cookie は、as_sid。HttpOnly、SameSite=Lax、期限つき', async () => {
        const browser = new Browser();

        const login = await toLogin(browser);

        const cookie = login.setCookies.find((raw) =>
            raw.startsWith('as_sid='),
        );
        expect(cookie).toBeDefined();
        expect(cookie).toMatch(/;\s*HttpOnly/i);
        expect(cookie).toMatch(/;\s*SameSite=Lax/i);
        expect(cookie).toMatch(/;\s*Path=\//i);
        expect(cookie).toMatch(/;\s*Expires=/i);
    });

    it('ログインしたあとの 2 回目の認可リクエストは、ログイン画面を出さずに、同意の画面へ進む', async () => {
        const browser = new Browser();
        const { challenge } = pkcePair();
        await authorize(stack, browser, authorizeParams(stack, challenge));

        const second = await toLogin(browser);

        expect(second.url).toBe(`${stack.as.baseUrl}/consent`);
        expect(second.text).not.toContain('name="username"');
    });

    it('ログインしていないブラウザは、同意の画面にも、認可リクエストなしでは、進めない', async () => {
        const page = await new Browser().get(`${stack.as.baseUrl}/consent`);

        expect(page.status).toBe(400);
        expect(errorMessageOf(page.text)).toContain('認可リクエスト');
    });

    it('フォームに、CSRF のトークンが無い、または、別のセッションの物だと、断られる(403)', async () => {
        const browser = new Browser();
        const login = await toLogin(browser);
        const other = await toLogin(new Browser());

        const without = await browser.send(`${stack.as.baseUrl}/login`, {
            form: { username: stack.username, password: stack.password },
        });
        const foreign = await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(other.text),
                username: stack.username,
                password: stack.password,
            },
        });

        expect(without.status).toBe(403);
        expect(foreign.status).toBe(403);
        // 断られたあとも、正しいトークンなら、ログインできる
        const ok = await browser.send(`${stack.as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(login.text),
                username: stack.username,
                password: stack.password,
            },
        });
        expect(ok.url).toBe(`${stack.as.baseUrl}/consent`);
    });
});

describe('M1-AS 認可リクエストの、結果', () => {
    it('同意を拒否すると、error=access_denied と state が、client に戻される。コードは出ない', async () => {
        const { challenge } = pkcePair();
        const params = authorizeParams(stack, challenge);

        const page = await authorize(stack, new Browser(), params, 'deny');

        expect(page.status).toBe(303);
        expect(page.location?.startsWith(stack.redirectUri)).toBe(true);
        const query = callbackParams(page);
        expect(query.get('error')).toBe('access_denied');
        expect(query.get('state')).toBe(params['state']);
        expect(query.has('code')).toBe(false);
    });

    it('許可すると、code と state が、client に戻される(state は、そのまま)', async () => {
        const { challenge } = pkcePair();
        const params = authorizeParams(stack, challenge);

        const page = await authorize(stack, new Browser(), params);

        expect(page.location?.startsWith(stack.redirectUri)).toBe(true);
        const query = callbackParams(page);
        expect(query.get('state')).toBe(params['state']);
        expect(query.get('code')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
        expect(query.has('error')).toBe(false);
    });

    it('response_type が code 以外だと、error=unsupported_response_type', async () => {
        const { challenge } = pkcePair();
        const params = authorizeParams(stack, challenge, {
            response_type: 'token',
        });

        const page = await authorize(stack, new Browser(), params);

        expect(callbackParams(page).get('error')).toBe(
            'unsupported_response_type',
        );
        expect(callbackParams(page).get('state')).toBe(params['state']);
    });

    it('知らないスコープを求めると、error=invalid_scope', async () => {
        const { challenge } = pkcePair();
        const params = authorizeParams(stack, challenge, {
            scope: 'read admin',
        });

        const page = await authorize(stack, new Browser(), params);

        expect(callbackParams(page).get('error')).toBe('invalid_scope');
        expect(callbackParams(page).get('state')).toBe(params['state']);
    });

    it('求めたスコープが、そのままトークンに入る。scope が省略されると、既定の read だけ', async () => {
        const readOnly = await obtainToken(stack, { scope: 'read' });
        const none = await obtainToken(stack, { scope: '' });

        expect(readOnly.response.json['scope']).toBe('read');
        expect(decodeJwt(readOnly.accessToken).payload['scope']).toBe('read');
        expect(none.response.json['scope']).toBe('read');
        expect(decodeJwt(none.accessToken).payload['scope']).toBe('read');
    });
});
