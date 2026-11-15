import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from 'vitest';
import { SESSION_COOKIE_NAME } from '../lib/session.js';
import type { TokenExchangeResult, TokenSet } from '../oauth/token-request.js';
import {
    createClient,
    startServer,
    type TestClient,
    type TestResponse,
    type TestServer,
} from '../test-utils/http.js';
import { createPageTestApp, readSession } from '../test-utils/page-app.js';
import { createCallbackRouter, type CallbackDeps } from './callback.js';
import { createLoginRouter } from './login.js';

const CLIENT_ID = 'memoboard';
const CLIENT_SECRET = 'client-secret-for-test-0123456789abcdef';
const REDIRECT_URI = 'http://localhost:4001/callback';
const TOKEN_ENDPOINT = 'http://localhost:4000/token';

const TOKENS: TokenSet = {
    accessToken: 'at-from-the-as',
    expiresAt: 1_800_003_600,
    scope: 'read write',
};

type Exchange = NonNullable<CallbackDeps['exchangeCode']>;

// /__test/seed-state で入れる値
const PENDING_STATE = 's'.repeat(43);
const PENDING_VERIFIER = 'v'.repeat(43);

let server: TestServer;
let client: TestClient;
let exchange: Mock<Exchange>;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    exchange = vi.fn<Exchange>(async () => ({ ok: true, tokens: TOKENS }));
    server = await startServer(
        createPageTestApp((app) => {
            // テスト専用の道: state と code_verifier を、セッションに直接入れる
            // (ログイン済みだと /login は何も始めないので、ログイン中の人の、やり直しの途中を作るために使う)
            app.get('/__test/seed-state', (req, res) => {
                req.session.state = PENDING_STATE;
                req.session.codeVerifier = PENDING_VERIFIER;
                res.send('ok');
            });
            // テスト専用の道: state だけを入れる(code_verifier は、入れない)
            app.get('/__test/seed-state-only', (req, res) => {
                req.session.state = PENDING_STATE;
                res.send('ok');
            });
            // テスト専用の道: code_verifier だけを入れる(state は、入れない)
            app.get('/__test/seed-verifier-only', (req, res) => {
                req.session.codeVerifier = PENDING_VERIFIER;
                res.send('ok');
            });
            app.use(
                '/login',
                createLoginRouter({
                    clientId: CLIENT_ID,
                    redirectUri: REDIRECT_URI,
                    authorizationEndpoint: 'http://localhost:4000/authorize',
                    requestedScope: 'read write',
                }),
            );
            app.use(
                '/callback',
                createCallbackRouter({
                    clientId: CLIENT_ID,
                    clientSecret: CLIENT_SECRET,
                    redirectUri: REDIRECT_URI,
                    tokenEndpoint: TOKEN_ENDPOINT,
                    exchangeCode: exchange,
                }),
            );
        }),
    );
    client = createClient(server.baseUrl);
});

afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
});

// /login を通って、セッションに state と code_verifier を入れる(本物の /login を使う)
const beginLogin = async (who: TestClient = client) => {
    await who.get('/login');
    const session = await readSession(who);
    return {
        state: session.state ?? '',
        codeVerifier: session.codeVerifier ?? '',
    };
};

// ログイン済みの人が、ログインをやり直している途中の状態にする(今のトークンを返す)
const loggedInWithPendingLogin = async () => {
    await client.get('/__test/login');
    await client.get('/__test/seed-state');
    return (await readSession(client)).tokens;
};

const callback = (query: Record<string, string>, who: TestClient = client) =>
    who.get(`/callback?${new URLSearchParams(query)}`);

// 正しい callback(code と、セッションに入っている state)
const validCallback = async (code = 'code-1234') => {
    const { state, codeVerifier } = await beginLogin();
    const response = await callback({ code, state });
    return { response, state, codeVerifier };
};

// エラー画面(HTML)で返っていて、リダイレクトではないこと
const expectErrorPage = (response: TestResponse, status: number) => {
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.text).toContain('<html');
    expect(response.location).toBeNull();
};

describe('CALLBACK /callback 認可コードを持って戻ってくる所 RFC 6749 4.1.2 / RFC 9700 4.7', () => {
    describe('GET /callback: 成功', () => {
        it('トークンの引き換えを、1 回だけ呼ぶ。渡す物は、設定と、/login で取っておいた code_verifier', async () => {
            const { response, codeVerifier } = await validCallback('code-1234');

            expect(response.status).toBe(303);
            expect(exchange).toHaveBeenCalledOnce();
            expect(exchange).toHaveBeenCalledWith({
                tokenEndpoint: TOKEN_ENDPOINT,
                clientId: CLIENT_ID,
                clientSecret: CLIENT_SECRET,
                code: 'code-1234',
                redirectUri: REDIRECT_URI,
                codeVerifier,
            });
            expect(codeVerifier).not.toBe('');
        });

        it('code は、そのまま渡す(記号も、変えない)', async () => {
            await validCallback('ab+cd/ef=gh~ij.kl_mn-op');

            expect(exchange.mock.calls[0]?.[0].code).toBe(
                'ab+cd/ef=gh~ij.kl_mn-op',
            );
        });

        it('303 で /(code と state の付いていない道)へ飛ばす', async () => {
            const { response } = await validCallback();

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
        });

        it('トークンを、セッションに入れる(渡された物のまま)', async () => {
            await validCallback();

            expect((await readSession(client)).tokens).toEqual(TOKENS);
        });

        it('state と code_verifier は、セッションから消える', async () => {
            await validCallback();
            const session = await readSession(client);

            expect(session.state).toBeNull();
            expect(session.codeVerifier).toBeNull();
        });

        it('セッション ID を作り直す(セッション固定化攻撃の対策)', async () => {
            await beginLogin();
            const before = client.cookies.get(SESSION_COOKIE_NAME);
            const { state } = await readSession(client);

            await callback({ code: 'code-1234', state: state ?? '' });
            const after = client.cookies.get(SESSION_COOKIE_NAME);

            expect(before).toBeDefined();
            expect(after).toBeDefined();
            expect(after).not.toBe(before);
        });

        it('新しい Cookie を 1 本だけ出す', async () => {
            const { response } = await validCallback();

            expect(response.headers.getSetCookie()).toHaveLength(1);
        });

        it('古いセッション ID は、もう使えない(トークンも、見えない)', async () => {
            await beginLogin();
            const oldCookie = client.cookies.get(SESSION_COOKIE_NAME) ?? '';
            const { state } = await readSession(client);

            await callback({ code: 'code-1234', state: state ?? '' });

            const attacker = createClient(server.baseUrl);
            attacker.cookies.set(SESSION_COOKIE_NAME, oldCookie);
            const session = await readSession(attacker);
            expect(session.tokens).toBeNull();
            expect(session.state).toBeNull();
            // 比べるために、新しい Cookie では、見えること
            expect((await readSession(client)).tokens).toEqual(TOKENS);
        });

        it('次の画面に出す、メッセージ(flash)が入る。トークンは入らない', async () => {
            await validCallback();
            const { flash } = await readSession(client);

            expect(typeof flash).toBe('string');
            expect(flash).not.toBe('');
            expect(flash).not.toContain(TOKENS.accessToken);
        });

        it('キャッシュさせない', async () => {
            const { response } = await validCallback();

            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(response.headers.get('pragma')).toBe('no-cache');
        });

        it('知らないクエリの項目は、無視する', async () => {
            const { state } = await beginLogin();

            const response = await callback({
                code: 'code-1234',
                state,
                iss: 'http://localhost:4000',
                foo: 'bar',
            });

            expect(response.status).toBe(303);
            expect(exchange).toHaveBeenCalledOnce();
        });

        it('すでにログインしている人が、ログインをやり直したら、トークンが入れ替わる', async () => {
            const before = await loggedInWithPendingLogin();
            expect(before?.accessToken).toBe('test-access-token');

            const response = await callback({
                code: 'code-1234',
                state: PENDING_STATE,
            });

            expect(response.status).toBe(303);
            expect(exchange).toHaveBeenCalledOnce();
            expect(exchange.mock.calls[0]?.[0].codeVerifier).toBe(
                PENDING_VERIFIER,
            );
            expect((await readSession(client)).tokens).toEqual(TOKENS);
        });
    });

    describe('GET /callback: state(RFC 6749 10.12、RFC 9700 4.7)', () => {
        it('state が、取っておいた物と違えば、400 のエラー画面。引き換えない', async () => {
            await beginLogin();

            const response = await callback({
                code: 'code-1234',
                state: 'x'.repeat(43),
            });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
            expect((await readSession(client)).tokens).toBeNull();
        });

        it.each([
            { name: 'state が無い', query: { code: 'code-1234' } },
            { name: 'state が空', query: { code: 'code-1234', state: '' } },
        ])('$name なら、400。引き換えない', async ({ query }) => {
            await beginLogin();

            const response = await callback(query);

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('state が 2 つあれば、400。引き換えない', async () => {
            const { state } = await beginLogin();

            const response = await client.get(
                `/callback?code=code-1234&state=${state}&state=${state}`,
            );

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('/login を通っていない(セッションに state が無い)なら、400。Cookie も出さない', async () => {
            const response = await callback({
                code: 'code-1234',
                state: 'a'.repeat(43),
            });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
            expect(response.headers.getSetCookie()).toEqual([]);
        });

        it('state だけあって、code_verifier が無い(あり得ない状態)なら、400。引き換えない', async () => {
            await client.get('/__test/seed-state-only');

            const response = await callback({
                code: 'code-1234',
                state: PENDING_STATE,
            });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('code_verifier だけあって、state が無い(あり得ない状態)なら、届いた state を信用せずに、400。引き換えない', async () => {
            await client.get('/__test/seed-verifier-only');

            const response = await callback({
                code: 'code-1234',
                state: 'attacker-chosen-state',
            });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('1 回きり: 成功した callback を、もう一度送っても、400', async () => {
            const { state } = await beginLogin();

            const first = await callback({ code: 'code-1234', state });
            const second = await callback({ code: 'code-1234', state });

            expect(first.status).toBe(303);
            expectErrorPage(second, 400);
            expect(exchange).toHaveBeenCalledOnce();
        });

        it('失敗した callback でも、取っておいた state と code_verifier は、消える', async () => {
            const { state } = await beginLogin();

            await callback({ code: 'code-1234', state: 'wrong-state' });
            const session = await readSession(client);
            // そのあと、正しい state で来ても、もう使えない
            const retry = await callback({ code: 'code-1234', state });

            expect(session.state).toBeNull();
            expect(session.codeVerifier).toBeNull();
            expectErrorPage(retry, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('古い /login の state は、使えない(もう一度 /login したら、新しい state だけが有効)', async () => {
            const first = await beginLogin();
            const second = await beginLogin();

            const withOld = await callback({
                code: 'code-1234',
                state: first.state,
            });

            expect(first.state).not.toBe(second.state);
            expectErrorPage(withOld, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('別の人(別のセッション)の state は、使えない', async () => {
            const victim = await beginLogin();
            const attacker = createClient(server.baseUrl);
            await beginLogin(attacker);

            const response = await callback(
                { code: 'attackers-code', state: victim.state },
                attacker,
            );

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('state が合わない時は、error が付いていても、エラーの知らせとしては扱わない(400。メッセージも入らない)', async () => {
            await beginLogin();

            const response = await callback({
                error: 'access_denied',
                state: 'wrong-state',
            });
            const session = await readSession(client);

            expectErrorPage(response, 400);
            expect(session.flash).toBeNull();
        });

        it('エラー画面に、クエリの中身(code、state、説明文)を出さない', async () => {
            await beginLogin();

            const response = await callback({
                code: '<script>alert(1)</script>',
                state: '<b>forged-state</b>',
                error_description: '<i>forged-description</i>',
            });

            expectErrorPage(response, 400);
            expect(response.text).not.toContain('alert(1)');
            expect(response.text).not.toContain('forged-state');
            expect(response.text).not.toContain('forged-description');
        });

        it('エラー画面も、キャッシュさせない', async () => {
            await beginLogin();

            const response = await callback({
                code: 'code-1234',
                state: 'wrong-state',
            });

            expect(response.headers.get('cache-control')).toBe('no-store');
        });
    });

    describe('GET /callback: AS が、エラーを知らせてきた時(RFC 6749 4.1.2.1)', () => {
        it('access_denied(許可しなかった)なら、/ へ 303。メッセージ(flash)を入れる。引き換えない', async () => {
            const { state } = await beginLogin();

            const response = await callback({ error: 'access_denied', state });
            const session = await readSession(client);

            expect(response.status).toBe(303);
            expect(response.location).toBe('/');
            expect(typeof session.flash).toBe('string');
            expect(session.flash).not.toBe('');
            expect(session.tokens).toBeNull();
            expect(exchange).not.toHaveBeenCalled();
        });

        it('access_denied でも、state と code_verifier は、消える', async () => {
            const { state } = await beginLogin();

            await callback({ error: 'access_denied', state });
            const session = await readSession(client);

            expect(session.state).toBeNull();
            expect(session.codeVerifier).toBeNull();
        });

        it('ログイン中の人が、やり直しを断っても、今のトークンは、消えない', async () => {
            const before = await loggedInWithPendingLogin();

            const response = await callback({
                error: 'access_denied',
                state: PENDING_STATE,
            });

            // 比べるために、断りとして、受け付けられていること
            expect(response.status).toBe(303);
            expect((await readSession(client)).tokens).toEqual(before);
        });

        it.each([
            'server_error',
            'temporarily_unavailable',
            'invalid_scope',
            'unauthorized_client',
            'invalid_request',
        ])('%s なら、502 のエラー画面。引き換えない', async (error) => {
            const { state } = await beginLogin();

            const response = await callback({ error, state });

            expectErrorPage(response, 502);
            expect(exchange).not.toHaveBeenCalled();
            expect((await readSession(client)).tokens).toBeNull();
        });

        it('AS が返した説明文(error_description)は、画面に出さない', async () => {
            const { state } = await beginLogin();

            const response = await callback({
                error: 'server_error',
                error_description: 'forged-or-leaky-description',
                state,
            });

            expectErrorPage(response, 502);
            expect(response.text).not.toContain('forged-or-leaky-description');
            expect(response.text).not.toContain('server_error');
        });

        it('error と code が、両方来たら、400', async () => {
            const { state } = await beginLogin();

            const response = await callback({
                error: 'access_denied',
                code: 'code-1234',
                state,
            });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('error に使えない文字(ダブルクォート)が入っていたら、400', async () => {
            const { state } = await beginLogin();

            const response = await callback({ error: 'a"b', state });

            expectErrorPage(response, 400);
        });
    });

    describe('GET /callback: code の形', () => {
        it.each([
            { name: 'code が無い', query: {} },
            { name: 'code が空', query: { code: '' } },
        ])('$name なら、400。引き換えない', async ({ query }) => {
            const { state } = await beginLogin();

            const response = await callback({ ...query, state });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('code が 2 つあれば、400', async () => {
            const { state } = await beginLogin();

            const response = await client.get(
                `/callback?code=a&code=b&state=${state}`,
            );

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('code に使えない文字(改行)が入っていたら、400', async () => {
            const { state } = await beginLogin();

            const response = await callback({ code: 'abc\ndef', state });

            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();
        });

        it('code が長すぎれば(513 文字)400。512 文字までは、通る', async () => {
            const tooLong = await beginLogin();
            const response = await callback({
                code: 'a'.repeat(513),
                state: tooLong.state,
            });
            expectErrorPage(response, 400);
            expect(exchange).not.toHaveBeenCalled();

            const ok = await beginLogin();
            const accepted = await callback({
                code: 'a'.repeat(512),
                state: ok.state,
            });
            expect(accepted.status).toBe(303);
            expect(exchange).toHaveBeenCalledOnce();
        });
    });

    describe('GET /callback: トークンの引き換えに失敗した時', () => {
        it('AS が断った(invalid_grant など)なら、400 のエラー画面。トークンは入らない', async () => {
            exchange.mockResolvedValue({
                ok: false,
                reason: 'rejected',
                error: 'invalid_grant',
                description: 'code expired',
            });

            const { response } = await validCallback();
            const session = await readSession(client);

            expectErrorPage(response, 400);
            expect(session.tokens).toBeNull();
            expect(session.flash).toBeNull();
        });

        it('通信できない、返事が読めない、などなら、502 のエラー画面。トークンは入らない', async () => {
            exchange.mockResolvedValue({
                ok: false,
                reason: 'failed',
                message: 'token endpoint: 通信に失敗しました(または時間切れ)',
            });

            const { response } = await validCallback();

            expectErrorPage(response, 502);
            expect((await readSession(client)).tokens).toBeNull();
        });

        it('失敗の理由は、ログに出す。画面には出さない', async () => {
            exchange.mockResolvedValue({
                ok: false,
                reason: 'failed',
                message: 'token endpoint: ログ用のメッセージ',
            });

            const { response } = await validCallback();

            expect(consoleError).toHaveBeenCalledOnce();
            expect(JSON.stringify(consoleError.mock.calls[0])).toContain(
                'ログ用のメッセージ',
            );
            expect(response.text).not.toContain('ログ用のメッセージ');
        });

        it('AS が断った時の error も、ログに出す。画面には出さない', async () => {
            exchange.mockResolvedValue({
                ok: false,
                reason: 'rejected',
                error: 'invalid_grant',
                description: 'leaky-description',
            });

            const { response } = await validCallback();

            expect(consoleError).toHaveBeenCalledOnce();
            expect(JSON.stringify(consoleError.mock.calls[0])).toContain(
                'invalid_grant',
            );
            expect(response.text).not.toContain('invalid_grant');
            expect(response.text).not.toContain('leaky-description');
        });

        it.each(['rejected', 'failed'] as const)(
            '%s の時、ログに、秘密(client_secret、code、code_verifier)を入れない',
            async (reason) => {
                exchange.mockResolvedValue(
                    reason === 'rejected'
                        ? { ok: false, reason, error: 'invalid_grant' }
                        : { ok: false, reason, message: 'token endpoint: x' },
                );

                const { codeVerifier } = await validCallback('secret-code-xyz');
                const logged = JSON.stringify(consoleError.mock.calls);

                expect(logged).not.toContain(CLIENT_SECRET);
                expect(logged).not.toContain('secret-code-xyz');
                expect(logged).not.toContain(codeVerifier);
            },
        );

        it('引き換えが、例外を投げたら、500 のエラー画面。中身は、画面に出さない', async () => {
            exchange.mockRejectedValue(new Error('SECRET-INTERNAL-DETAIL'));

            const { response } = await validCallback();

            expectErrorPage(response, 500);
            expect(response.text).not.toContain('SECRET-INTERNAL-DETAIL');
            expect((await readSession(client)).tokens).toBeNull();
        });

        it('失敗のあとに、同じ callback を送り直しても、400(state は、使い終わっている)', async () => {
            exchange.mockResolvedValue({
                ok: false,
                reason: 'rejected',
                error: 'invalid_grant',
            });
            const { state } = await beginLogin();

            await callback({ code: 'code-1234', state });
            const retry = await callback({ code: 'code-1234', state });

            expectErrorPage(retry, 400);
            expect(exchange).toHaveBeenCalledOnce();
        });

        it('失敗の時は、ログイン中の人のトークンを、消さない', async () => {
            exchange.mockResolvedValue({
                ok: false,
                reason: 'rejected',
                error: 'invalid_grant',
            });
            const before = await loggedInWithPendingLogin();

            const response = await callback({
                code: 'code-1234',
                state: PENDING_STATE,
            });

            // 比べるために、引き換えまで進んで、断られていること
            expectErrorPage(response, 400);
            expect(exchange).toHaveBeenCalledOnce();
            expect((await readSession(client)).tokens).toEqual(before);
        });
    });

    describe('GET 以外', () => {
        it('POST は 405。Allow は GET。引き換えない', async () => {
            const { state } = await beginLogin();

            const response = await client.postForm('/callback', {
                code: 'code-1234',
                state,
            });

            expect(response.status).toBe(405);
            expect(response.headers.get('allow')).toBe('GET');
            expect(exchange).not.toHaveBeenCalled();
        });
    });
});
