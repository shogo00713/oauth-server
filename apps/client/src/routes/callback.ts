import express, { type Router } from 'express';
import { sendErrorPage } from '../lib/page-errors.js';
import { noStore } from '../lib/security-headers.js';
import { parseCallback } from '../oauth/callback.js';
import {
    exchangeCode,
    type TokenExchangeInput,
    type TokenExchangeResult,
} from '../oauth/token-request.js';

export type CallbackDeps = {
    clientId: string;
    clientSecret: string;
    // 認可リクエストで送った物と、同じ値
    redirectUri: string;
    tokenEndpoint: string;
    // トークンの引き換え。テストで差し替えられる。省略したら、本物(exchangeCode)
    exchangeCode?:
        | ((input: TokenExchangeInput) => Promise<TokenExchangeResult>)
        | undefined;
};

// 画面に出す言葉
const MESSAGES = {
    badState:
        'ログインの確認に失敗しました(有効期限が切れたか、不正なリクエストです)。もう一度、ログインからやり直してください',
    malformed:
        'リクエストが正しくありません。もう一度、ログインからやり直してください',
    asError:
        '認可サーバーでエラーが起きました。時間をおいて、もう一度、ログインしてください',
    rejected:
        'ログインに失敗しました。もう一度、ログインからやり直してください',
    unreachable:
        '認可サーバーと通信できませんでした。時間をおいて、もう一度、ログインしてください',
    denied: 'ログインを中止しました(アプリに許可が出されませんでした)',
    loggedIn: 'ログインしました',
} as const;

/**
 * GET /callback: AS から、認可コードを持って戻ってくる所(redirect_uri)
 *   RFC 6749 4.1.2 / 4.1.2.1、RFC 9700 4.7(state は、セッションに結びつけて、1 回だけ使う)
 */
export function createCallbackRouter(deps: CallbackDeps): Router {
    const router = express.Router();
    const exchange = deps.exchangeCode ?? exchangeCode;

    // code や state が付いた URL の返事を、キャッシュさせない
    router.use(noStore);

    router.get('/', async (req, res) => {
        // 1. 取っておいた state と code_verifier を、取り出して、すぐ消す(結果がどうでも、1 回で捨てる)
        const { state: expectedState, codeVerifier } = req.session;
        delete req.session.state;
        delete req.session.codeVerifier;

        // 2. クエリの検査(state が先。合わなければ、error も code も、信用しない)
        const result = parseCallback(req.query, expectedState);
        if (result.kind === 'invalid') {
            return sendErrorPage(
                res,
                400,
                result.reason === 'state_mismatch'
                    ? MESSAGES.badState
                    : MESSAGES.malformed,
            );
        }
        if (result.kind === 'error') {
            // AS の返した説明文は、画面に出さない(他所から来た文字なので)
            if (result.error === 'access_denied') {
                req.session.flash = MESSAGES.denied;
                return res.redirect(303, '/');
            }
            return sendErrorPage(res, 502, MESSAGES.asError);
        }
        // state と code_verifier は、一緒に入れるので、片方だけ無い事は無いはず
        if (!codeVerifier) {
            return sendErrorPage(res, 400, MESSAGES.badState);
        }

        // 3. トークンの引き換え
        const outcome = await exchange({
            tokenEndpoint: deps.tokenEndpoint,
            clientId: deps.clientId,
            clientSecret: deps.clientSecret,
            code: result.code,
            redirectUri: deps.redirectUri,
            codeVerifier,
        });
        if (!outcome.ok) {
            // ログには、理由だけ(code、code_verifier、秘密は、入れない)
            console.error(
                'token exchange failed:',
                outcome.reason === 'rejected'
                    ? `rejected (${outcome.error})`
                    : outcome.message,
            );
            return outcome.reason === 'rejected'
                ? sendErrorPage(res, 400, MESSAGES.rejected)
                : sendErrorPage(res, 502, MESSAGES.unreachable);
        }

        // 4. 成功: セッション ID を作り直して(固定化攻撃への対策)、トークンを入れる
        await new Promise<void>((resolve, reject) => {
            req.session.regenerate((error) =>
                error ? reject(error) : resolve(),
            );
        });
        req.session.tokens = outcome.tokens;
        req.session.flash = MESSAGES.loggedIn;
        // code と state の付いていない道へ
        res.redirect(303, '/');
    });

    // GET 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'GET').end();
    });

    return router;
}
