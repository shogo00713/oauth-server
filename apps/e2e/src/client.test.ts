/**
 * M1 の完了条件: client(docs/milestones/m1.md の「client」)
 *   - state の発行と検証
 *   - Cookie 管理
 *   - client のログアウト
 *   - オープンリダイレクト対策
 * 本物の client(メモボード)を、本物の AS、RS と一緒に起動して、ブラウザの代わりに、たたく
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    Browser,
    csrfOf,
    errorMessageOf,
    flashOf,
    memosOnPage,
} from './helpers/browser.js';
import { authorize, loginThroughClient } from './helpers/oauth.js';
import { startStack, type Stack } from './helpers/stack.js';

let stack: Stack;

beforeAll(async () => {
    stack = await startStack();
});

afterAll(async () => {
    await stack.stop();
});

const WELCOME = 'ログインして始める';
const LIST = 'メモ一覧';

// 「ログイン」を押して、AS が受け取る認可リクエストを、取り出す(AS には、まだ行かない)
async function startLogin(browser: Browser) {
    const page = await browser.get(`${stack.client.baseUrl}/login`, {
        follow: false,
    });
    if (!page.location) throw new Error('リダイレクトではありません');
    const url = new URL(page.location);
    return { page, url, params: url.searchParams };
}

// AS で、ログインと同意を済ませて、client に戻る URL(code と state が付いた物)を、もらう
async function authorizeAtAs(browser: Browser, params: URLSearchParams) {
    const page = await authorize(stack, browser, Object.fromEntries(params));
    if (!page.location) throw new Error('client に戻りませんでした');
    return new URL(page.location);
}

describe('M1-CLIENT state の発行と検証', () => {
    it('「ログイン」は、AS の認可エンドポイントへの 303。パラメータは、設定から作られて、秘密は入らない', async () => {
        const { page, url, params } = await startLogin(new Browser());

        expect(page.status).toBe(303);
        expect(url.origin).toBe(stack.as.baseUrl);
        expect(url.pathname).toBe('/authorize');
        expect([...params.keys()].sort()).toEqual([
            'client_id',
            'code_challenge',
            'code_challenge_method',
            'redirect_uri',
            'response_type',
            'scope',
            'state',
        ]);
        expect(Object.fromEntries(params)).toMatchObject({
            response_type: 'code',
            client_id: stack.clientId,
            redirect_uri: stack.redirectUri,
            scope: 'read write',
            code_challenge_method: 'S256',
        });
        expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
        expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(page.location).not.toContain(stack.clientSecret);
    });

    it('state と code_challenge は、「ログイン」のたびに、違う値', async () => {
        const first = await startLogin(new Browser());
        const second = await startLogin(new Browser());

        expect(second.params.get('state')).not.toBe(first.params.get('state'));
        expect(second.params.get('code_challenge')).not.toBe(
            first.params.get('code_challenge'),
        );
    });

    it('正しい state で戻ってくると、ログインできる', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);
        const callback = await authorizeAtAs(browser, params);

        expect(callback.searchParams.get('state')).toBe(params.get('state'));
        const home = await browser.get(callback.toString());

        expect(home.url).toBe(`${stack.client.baseUrl}/`);
        expect(home.text).toContain(LIST);
    });

    it('state が違うと、400 のエラー画面。ログインは成り立たない', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);
        const callback = await authorizeAtAs(browser, params);
        callback.searchParams.set('state', `${params.get('state')}x`);

        const page = await browser.get(callback.toString());

        expect(page.status).toBe(400);
        expect(errorMessageOf(page.text)).toContain('ログインの確認に失敗');
        const home = await browser.get(`${stack.client.baseUrl}/`);
        expect(home.text).toContain(WELCOME);
        expect(home.text).not.toContain(LIST);
    });

    it.each(['state', 'code'])(
        '戻り先に %s が無いと、400。ログインは成り立たない',
        async (missing) => {
            const browser = new Browser();
            const { params } = await startLogin(browser);
            const callback = await authorizeAtAs(browser, params);
            callback.searchParams.delete(missing);

            const page = await browser.get(callback.toString());

            expect(page.status).toBe(400);
            const home = await browser.get(`${stack.client.baseUrl}/`);
            expect(home.text).toContain(WELCOME);
            expect(home.text).not.toContain(LIST);
        },
    );

    it('state は、1 回しか使えない。同じ戻り先を、もう一度たたいても、400', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);
        const callback = await authorizeAtAs(browser, params);
        const first = await browser.get(callback.toString());

        const replay = await browser.get(callback.toString());

        expect(first.text).toContain(LIST);
        expect(replay.status).toBe(400);
        expect(errorMessageOf(replay.text)).toContain('ログインの確認に失敗');
    });

    it('「ログイン」を通らずに、/callback をたたいても、400(セッションに state が無い)', async () => {
        const page = await new Browser().get(
            `${stack.client.baseUrl}/callback?code=abc&state=xyz`,
        );

        expect(page.status).toBe(400);
        expect(errorMessageOf(page.text)).toContain('ログインの確認に失敗');
    });

    it('state が正しくても、認可コードが偽物なら、AS が断る。ログインに失敗した画面(400)', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);

        const page = await browser.get(
            `${stack.client.baseUrl}/callback?code=forged-code&state=${params.get('state')}`,
        );

        expect(page.status).toBe(400);
        expect(errorMessageOf(page.text)).toContain('ログインに失敗しました');
        const home = await browser.get(`${stack.client.baseUrl}/`);
        expect(home.text).toContain(WELCOME);
    });

    it('AS が error を返してきた時: access_denied は、メッセージつきでトップへ。それ以外は、エラー画面(502)', async () => {
        const denied = new Browser();
        const first = await startLogin(denied);
        const deniedPage = await denied.get(
            `${stack.client.baseUrl}/callback?error=access_denied&state=${first.params.get('state')}`,
        );

        const failed = new Browser();
        const second = await startLogin(failed);
        const failedPage = await failed.get(
            `${stack.client.baseUrl}/callback?error=server_error&state=${second.params.get('state')}`,
        );

        expect(deniedPage.url).toBe(`${stack.client.baseUrl}/`);
        expect(flashOf(deniedPage.text)).toContain('ログインを中止しました');
        expect(failedPage.status).toBe(502);
        // AS の説明文(error_description)は、画面に出さない
        const injected = await failed.get(
            `${stack.client.baseUrl}/callback?error=access_denied&error_description=<script>x</script>&state=nope`,
        );
        expect(injected.status).toBe(400);
        expect(injected.text).not.toContain('<script>x</script>');
    });

    it('state が無い状態で、error だけ付けて来ても、信用しない(400)', async () => {
        const browser = new Browser();
        await startLogin(browser);

        const page = await browser.get(
            `${stack.client.baseUrl}/callback?error=access_denied`,
        );

        expect(page.status).toBe(400);
    });
});

describe('M1-CLIENT オープンリダイレクト対策', () => {
    it('「ログイン」の飛ばし先は、設定から作る。リクエストのクエリは、見ない', async () => {
        const evil = 'https://evil.example';
        const query = new URLSearchParams({
            next: evil,
            returnTo: evil,
            redirect_uri: `${evil}/callback`,
            state: 'chosen-by-attacker',
            code_challenge: 'chosen-by-attacker',
            scope: 'admin',
            client_id: 'someone-else',
        });

        const page = await new Browser().get(
            `${stack.client.baseUrl}/login?${query}`,
            { follow: false },
        );
        const url = new URL(page.location ?? '');
        const params = url.searchParams;

        expect(url.origin).toBe(stack.as.baseUrl);
        expect(page.location).not.toContain('evil.example');
        expect(params.get('redirect_uri')).toBe(stack.redirectUri);
        expect(params.get('client_id')).toBe(stack.clientId);
        expect(params.get('scope')).toBe('read write');
        expect(params.get('state')).not.toBe('chosen-by-attacker');
        expect(params.get('code_challenge')).not.toBe('chosen-by-attacker');
    });

    it('ログインが済んだあとの行き先は、いつも client のトップ(/)。リクエストで変えられない', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);
        const callback = await authorizeAtAs(browser, params);
        callback.searchParams.set('next', 'https://evil.example');
        callback.searchParams.set('redirect_uri', 'https://evil.example');

        const page = await browser.get(callback.toString(), { follow: false });

        expect(page.status).toBe(303);
        expect(page.location).toBe(`${stack.client.baseUrl}/`);
    });

    it('ログアウトやメモの操作のあとの行き先も、client の中だけ', async () => {
        const browser = new Browser();
        const home = await loginThroughClient(stack, browser);
        const csrf = csrfOf(home.text);

        const create = await browser.send(`${stack.client.baseUrl}/`, {
            form: { _csrf: csrf, body: 'x', next: 'https://evil.example' },
            follow: false,
        });
        const logout = await browser.send(`${stack.client.baseUrl}/logout`, {
            form: { _csrf: csrf, next: 'https://evil.example' },
            follow: false,
        });

        expect(create.location).toBe(`${stack.client.baseUrl}/`);
        expect(logout.location).toBe(`${stack.client.baseUrl}/`);
    });
});

describe('M1-CLIENT Cookie 管理', () => {
    it('セッションの Cookie は、memoboard_sid。HttpOnly、SameSite=Lax、期限つき。ログインで、ID が作り直される', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);
        const before = browser.cookie(stack.client.baseUrl, 'memoboard_sid');
        const callback = await authorizeAtAs(browser, params);

        const home = await browser.get(callback.toString());
        const after = browser.cookie(stack.client.baseUrl, 'memoboard_sid');

        const cookie = home.setCookies.find((raw) =>
            raw.startsWith('memoboard_sid='),
        );
        expect(cookie).toBeDefined();
        expect(cookie).toMatch(/;\s*HttpOnly/i);
        expect(cookie).toMatch(/;\s*SameSite=Lax/i);
        expect(cookie).toMatch(/;\s*Path=\//i);
        expect(cookie).toMatch(/;\s*Expires=/i);
        // セッション ID を作り直す(固定化攻撃への対策)
        expect(before).toBeDefined();
        expect(after).toBeDefined();
        expect(after).not.toBe(before);
    });

    it('Cookie に入っているのは、セッションの ID だけ。トークンは、サーバーの中', async () => {
        const browser = new Browser();
        await loginThroughClient(stack, browser);

        const value = browser.cookie(stack.client.baseUrl, 'memoboard_sid');

        expect(value).toBeDefined();
        expect(decodeURIComponent(value ?? '')).toMatch(
            /^s:[\w-]+\.[\w+/=-]+$/,
        );
        expect(value).not.toMatch(/eyJ/);
    });

    it('AS の Cookie(as_sid)と client の Cookie(memoboard_sid)は、別の名前。AS にログインしただけでは、client のメモは見えない', async () => {
        const browser = new Browser();
        const { params } = await startLogin(browser);
        await authorizeAtAs(browser, params);

        const home = await browser.get(`${stack.client.baseUrl}/`);

        expect(browser.cookie(stack.as.baseUrl, 'as_sid')).toBeDefined();
        expect(
            browser.cookie(stack.client.baseUrl, 'memoboard_sid'),
        ).toBeDefined();
        expect(home.text).toContain(WELCOME);
        expect(home.text).not.toContain(LIST);
    });

    it('ログインしていないブラウザは、メモの画面にも入れない(トップへ戻される)', async () => {
        const page = await new Browser().get(
            `${stack.client.baseUrl}/detail/abc`,
        );

        expect(page.url).toBe(`${stack.client.baseUrl}/`);
        expect(page.text).toContain(WELCOME);
    });
});

describe('M1-CLIENT CSRF 対策(フォームの送信)', () => {
    it('メモの作成、更新、削除は、CSRF のトークンが無い、または、別のセッションの物だと、403。何も変わらない', async () => {
        const alice = new Browser();
        const aliceHome = await loginThroughClient(stack, alice);
        const bob = new Browser();
        const bobCsrf = csrfOf((await loginThroughClient(stack, bob)).text);
        const marker = `csrf-${randomUUID()}`;
        const created = await alice.send(`${stack.client.baseUrl}/`, {
            form: { _csrf: csrfOf(aliceHome.text), body: marker },
        });
        const id =
            memosOnPage(created.text).find((memo) => memo.body === marker)
                ?.id ?? '';
        const url = `${stack.client.baseUrl}/detail/${id}`;

        const attempts = [
            await alice.send(`${stack.client.baseUrl}/`, {
                form: { body: 'no token' },
            }),
            await alice.send(`${stack.client.baseUrl}/`, {
                form: { _csrf: bobCsrf, body: 'bob token' },
            }),
            await alice.send(url, { form: { action: 'delete' } }),
            await alice.send(url, {
                form: { _csrf: bobCsrf, action: 'delete' },
            }),
            await alice.send(url, {
                form: { _csrf: bobCsrf, action: 'update', body: 'hijacked' },
            }),
        ];

        for (const page of attempts) expect(page.status).toBe(403);
        const list = await alice.get(`${stack.client.baseUrl}/`);
        expect(memosOnPage(list.text).map((memo) => memo.body)).toEqual(
            expect.arrayContaining([marker]),
        );
        expect(list.text).not.toContain('no token');
        expect(list.text).not.toContain('bob token');
        expect(list.text).not.toContain('hijacked');
    });

    it('ログインしていないブラウザの送信は、403', async () => {
        const page = await new Browser().send(`${stack.client.baseUrl}/`, {
            form: { _csrf: 'anything', body: 'x' },
        });

        expect(page.status).toBe(403);
    });
});

describe('M1-CLIENT ログアウト', () => {
    it('CSRF のトークンが無いログアウトは、403。ログインしたまま', async () => {
        const browser = new Browser();
        await loginThroughClient(stack, browser);

        const page = await browser.send(`${stack.client.baseUrl}/logout`, {
            form: {},
        });

        expect(page.status).toBe(403);
        const home = await browser.get(`${stack.client.baseUrl}/`);
        expect(home.text).toContain(LIST);
    });

    it('ログアウトすると、セッションが捨てられる(Cookie を、そのまま使い回しても、ログインしていない)', async () => {
        const browser = new Browser();
        const home = await loginThroughClient(stack, browser);
        const oldCookie =
            browser.cookie(stack.client.baseUrl, 'memoboard_sid') ?? '';

        const out = await browser.send(`${stack.client.baseUrl}/logout`, {
            form: { _csrf: csrfOf(home.text) },
        });

        expect(out.url).toBe(`${stack.client.baseUrl}/`);
        expect(flashOf(out.text)).toBe('ログアウトしました');
        expect(out.text).toContain(WELCOME);
        // 古い Cookie を、別のブラウザに入れても、ログインしていない
        const replay = new Browser();
        replay.setCookie(stack.client.baseUrl, 'memoboard_sid', oldCookie);
        const page = await replay.get(`${stack.client.baseUrl}/`);
        expect(page.text).toContain(WELCOME);
        expect(page.text).not.toContain(LIST);
        const detail = await replay.get(`${stack.client.baseUrl}/detail/abc`);
        expect(detail.url).toBe(`${stack.client.baseUrl}/`);
    });

    it('AS のセッションは、残る。すぐ「ログイン」しても、AS のログイン画面は出ず、同意の画面から始まる', async () => {
        const browser = new Browser();
        const home = await loginThroughClient(stack, browser);
        await browser.send(`${stack.client.baseUrl}/logout`, {
            form: { _csrf: csrfOf(home.text) },
        });

        const again = await browser.get(`${stack.client.baseUrl}/login`);

        expect(again.url).toBe(`${stack.as.baseUrl}/consent`);
        expect(again.text).not.toContain('name="username"');
    });

    it('ログアウトのあと、同じブラウザで、もう一度ログインできる。前のメモも、見える(メモは、持ち主のもの)', async () => {
        const browser = new Browser();
        const home = await loginThroughClient(stack, browser);
        const marker = `again-${randomUUID()}`;
        await browser.send(`${stack.client.baseUrl}/`, {
            form: { _csrf: csrfOf(home.text), body: marker },
        });
        const logout = await browser.send(`${stack.client.baseUrl}/logout`, {
            form: { _csrf: csrfOf(home.text) },
        });
        expect(logout.text).toContain(WELCOME);

        // 2 回目: AS は、ログイン済みなので、同意の画面から
        const consent = await browser.get(`${stack.client.baseUrl}/login`);
        const second = await browser.send(`${stack.as.baseUrl}/consent`, {
            form: { _csrf: csrfOf(consent.text), decision: 'allow' },
        });

        expect(second.url).toBe(`${stack.client.baseUrl}/`);
        expect(memosOnPage(second.text).map((memo) => memo.body)).toContain(
            marker,
        );
    });
});
