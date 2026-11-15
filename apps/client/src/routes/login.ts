import express, { type Router } from 'express';
import { currentTokens } from '../lib/auth-session.js';
import { createPkcePair } from '../lib/pkce.js';
import { generateRandomString } from '../lib/random.js';
import { noStore } from '../lib/security-headers.js';
import { buildAuthorizeUrl } from '../oauth/authorize-url.js';

export type LoginDeps = {
    clientId: string;
    // AS が、認可コードを持って戻ってくる URL(AS に登録した物と、同じ値)
    redirectUri: string;
    authorizationEndpoint: string;
    // 認可リクエストで求める、スコープ(空白区切り)
    requestedScope: string;
    // 今の時刻(秒)を返す関数。テストで差し替えられる。省略したら、本物の時計
    now?: (() => number) | undefined;
};

/**
 * GET /login: 認可リクエストを始める(RFC 6749 4.1.1、RFC 7636)
 *   state と code_verifier を作って、セッションに入れて、AS の認可エンドポイントへ 303 で飛ばす
 *   飛ばす先は、設定から作る。リクエストのクエリは、見ない(オープンリダイレクトにしない)
 */
export function createLoginRouter(deps: LoginDeps): Router {
    const router = express.Router();
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    // リダイレクトを、キャッシュさせない(キャッシュされると、state がセッションに入らないまま、飛ぶことになる)
    router.use(noStore);

    router.get('/', (req, res) => {
        // すでにログインしていれば、始めない
        if (currentTokens(req.session, now())) {
            return res.redirect(303, '/');
        }

        const state = generateRandomString();
        const { codeVerifier, codeChallenge } = createPkcePair();
        // 飛ばす先を先に作る(作れなかった時に、セッションに、何も残さないため)
        const location = buildAuthorizeUrl({
            authorizationEndpoint: deps.authorizationEndpoint,
            clientId: deps.clientId,
            redirectUri: deps.redirectUri,
            scope: deps.requestedScope,
            state,
            codeChallenge,
        });

        // 前の state と code_verifier は、上書きされて、使えなくなる
        req.session.state = state;
        req.session.codeVerifier = codeVerifier;
        res.redirect(303, location);
    });

    // GET 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'GET').end();
    });

    return router;
}
