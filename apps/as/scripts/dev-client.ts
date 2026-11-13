/**
 * 認可サーバーの動作確認用の、アプリ(クライアント)の代わり(デモ専用)
 *
 * 使い方(AS を、別のターミナルで動かしておく):
 *   pnpm --filter @oauth/as dev:client
 *   pnpm --filter @oauth/as dev:client -- --scope "read write"
 *
 * やること
 * 1. PKCE の code_verifier と code_challenge、state を作る
 * 2. 認可の URL を、画面に出す(これを、ブラウザで開く)
 * 3. 登録した redirect_uri の場所で待って、戻ってきた code と state を受ける
 * 4. code を、/token でアクセストークンに引き換えて、中身を表示する
 *
 * 環境変数: ISSUER、CLIENT_ID、CLIENT_SECRET、CLIENT_REDIRECT_URIS(AS と同じ .env を使う)
 */
import http from 'node:http';
import { computeCodeChallenge } from '../src/lib/pkce.js';
import { generateRandomString } from '../src/lib/random.js';

const WAIT_MINUTES = 5;

const fail = (message: string): never => {
    console.error(message);
    process.exit(1);
};

const issuer =
    process.env['ISSUER'] ??
    fail('ISSUER が、環境変数にありません(.env を確認)');
const clientId = process.env['CLIENT_ID'] || 'memoboard';
const clientSecret =
    process.env['CLIENT_SECRET'] ??
    fail('CLIENT_SECRET が、環境変数にありません(.env を確認)');
const redirectUri = (process.env['CLIENT_REDIRECT_URIS'] ?? '').split(' ')[0];
if (!redirectUri) fail('CLIENT_REDIRECT_URIS が、環境変数にありません');
const redirect = new URL(redirectUri ?? '');
if (!redirect.port) fail('redirect_uri に、ポート番号を付けてください');

// --scope "read write" を読む(無ければ、scope は付けない = AS の既定)
const scopeIndex = process.argv.indexOf('--scope');
const scope = scopeIndex === -1 ? undefined : process.argv[scopeIndex + 1];

const codeVerifier = generateRandomString();
const state = generateRandomString(16);

const authorizeUrl = new URL('/authorize', issuer);
authorizeUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirect.href,
    code_challenge: computeCodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    ...(scope ? { scope } : {}),
}).toString();

// JWT の、ヘッダーと中身を、読める形にする(署名は、確かめない。見るだけ)
const decodeJwt = (jwt: string) =>
    jwt
        .split('.')
        .slice(0, 2)
        .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));

const exchange = async (code: string) => {
    const response = await fetch(new URL('/token', issuer), {
        method: 'POST',
        headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirect.href,
            code_verifier: codeVerifier,
        }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    console.log(`\n/token の返事: ${response.status}`);
    if (typeof body['access_token'] !== 'string') {
        console.log(JSON.stringify(body));
        return;
    }
    const { access_token, ...others } = body;
    const [header, payload] = decodeJwt(access_token);
    console.log('レスポンス(access_token 以外):', JSON.stringify(others));
    console.log('JWT ヘッダー  :', JSON.stringify(header));
    console.log('JWT 中身      :', JSON.stringify(payload));
    console.log(`\naccess_token:\n${access_token}`);
};

const page = (message: string) =>
    `<!doctype html><meta charset="utf-8"><title>dev-client</title><p>${message}</p>`;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', redirect.origin);
    if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
    }

    const send = (status: number, message: string) =>
        res
            .writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
            .end(page(message));

    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');

    // state が違う = 自分が始めた認可じゃない(CSRF の疑い)。何もせずに、終わる
    if (url.searchParams.get('state') !== state) {
        send(400, 'state が違います');
        console.error('戻ってきた state が、送った物と違います。やめます');
        process.exitCode = 1;
    } else if (error) {
        send(200, `AS からエラーが戻りました: ${error}`);
        console.log(
            `\nAS からエラーが戻りました: ${error} ${url.searchParams.get('error_description') ?? ''}`,
        );
    } else if (code) {
        send(200, 'アプリに戻りました。ターミナルを見てください');
        console.log('\nアプリの /callback に、認可コードが戻りました');
        await exchange(code);
    } else {
        send(400, 'code も error も、ありません');
        process.exitCode = 1;
    }

    server.close();
    server.closeAllConnections();
});

server.listen(Number(redirect.port), redirect.hostname, () => {
    console.log('この URL を、ブラウザで開いてください:\n');
    console.log(authorizeUrl.href);
    console.log(
        `\n(${redirect.href} で待っています。${WAIT_MINUTES} 分で、あきらめます)`,
    );
});

setTimeout(
    () => {
        console.error('時間切れです');
        process.exit(1);
    },
    WAIT_MINUTES * 60 * 1000,
).unref();
