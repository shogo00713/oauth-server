import express, { type Router } from 'express';
import {
    buildAuthzErrorUrl,
    buildAuthzSuccessUrl,
} from '../lib/authz-response.js';
import { ensureCsrfToken, isValidCsrfToken } from '../lib/csrf.js';
import { sha256Hex } from '../lib/hash.js';
import { sendErrorPage } from '../lib/page-errors.js';
import { readParam } from '../lib/params.js';
import { generateRandomString } from '../lib/random.js';
import { noStore } from '../lib/security-headers.js';
import type { ClientStore } from '../stores/client-store.js';
import type { CodeStore } from '../stores/code-store.js';
import type { UserStore } from '../stores/user-store.js';

export type ConsentDeps = {
    clientStore: ClientStore;
    userStore: UserStore;
    codeStore: CodeStore;
    // 認可コードの寿命(秒)
    codeTtlSec: number;
    // 今の時刻(秒)を返す関数。テストで差し替えられる。省略したら、本物の時計
    now?: (() => number) | undefined;
};

// 画面に出す言葉
const MESSAGES = {
    noPending:
        '認可リクエストが見つかりません。アプリから、もう一度やり直してください',
    noClient:
        'アプリの情報を取得できませんでした。アプリから、もう一度やり直してください',
    badCsrf:
        'フォームの有効期限が切れたか、不正なリクエストです。アプリから、もう一度やり直してください',
    badDecision: 'リクエストが正しくありません。もう一度やり直してください',
} as const;

// スコープの説明(画面に出す)。知らないスコープは、名前だけ出す
const SCOPE_DESCRIPTIONS = new Map([
    ['read', 'メモを読む'],
    ['write', 'メモを作る・書き換える・消す'],
]);

const describeScopes = (scopes: readonly string[]) =>
    scopes.map((name) => ({
        name,
        description: SCOPE_DESCRIPTIONS.get(name) ?? '',
    }));

export function createConsentRouter(deps: ConsentDeps): Router {
    const router = express.Router();
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    // 画面や、リダイレクトを、キャッシュさせない
    router.use(noStore);

    router.get('/', async (req, res) => {
        const pending = req.session.pending;
        if (!pending) {
            return sendErrorPage(res, 400, MESSAGES.noPending);
        }
        const userId = req.session.userId;
        if (!userId) {
            return res.redirect(303, '/login');
        }

        const client = await deps.clientStore.find(pending.clientId);
        if (!client) {
            return sendErrorPage(res, 400, MESSAGES.noClient);
        }
        const user = await deps.userStore.findById(userId);
        if (!user) {
            // 居ない人のログインの記録は、消す(残すと、/login と /consent を行き来し続ける)
            delete req.session.userId;
            return res.redirect(303, '/login');
        }

        res.render('consent', {
            clientName: client.name,
            username: user.username,
            scopes: describeScopes(pending.scope),
            csrfToken: ensureCsrfToken(req.session),
        });
    });

    router.post(
        '/',
        express.urlencoded({ extended: false }),
        async (req, res) => {
            // 1. CSRF(RFC 6749 10.12)
            if (
                !isValidCsrfToken(
                    req.session.csrfToken,
                    readParam(req.body, '_csrf'),
                )
            ) {
                return sendErrorPage(res, 403, MESSAGES.badCsrf);
            }

            // 2. 取っておいた認可リクエスト、ログインした人、アプリ
            const pending = req.session.pending;
            if (!pending) {
                return sendErrorPage(res, 400, MESSAGES.noPending);
            }
            const userId = req.session.userId;
            if (!userId) {
                return res.redirect(303, '/login');
            }
            const client = await deps.clientStore.find(pending.clientId);
            if (!client) {
                return sendErrorPage(res, 400, MESSAGES.noClient);
            }
            const user = await deps.userStore.findById(userId);
            if (!user) {
                delete req.session.userId;
                return res.redirect(303, '/login');
            }

            // 3. 許可か、拒否か
            const decision = readParam(req.body, 'decision');
            if (decision !== 'allow' && decision !== 'deny') {
                return sendErrorPage(res, 400, MESSAGES.badDecision);
            }

            if (decision === 'deny') {
                // RFC 6749 4.1.2.1: access_denied と、state を付けて、戻す
                const location = buildAuthzErrorUrl(pending.redirectUri, {
                    error: 'access_denied',
                    description: 'The resource owner denied the request',
                    state: pending.state,
                });
                delete req.session.pending;
                return res.redirect(303, location);
            }

            // 許可: 認可コードを作る(戻す URL を先に作る。作れなかった時に、コードを残さないため)
            const code = generateRandomString();
            const location = buildAuthzSuccessUrl(pending.redirectUri, {
                code,
                state: pending.state,
            });
            await deps.codeStore.save(sha256Hex(code), {
                clientId: pending.clientId,
                redirectUri: pending.redirectUri,
                codeChallenge: pending.codeChallenge,
                sub: user.id,
                scope: pending.scope,
                expiresAt: now() + deps.codeTtlSec,
            });

            // 1 回きり(同じフォームを、もう一度送っても、2 つ目のコードは出ない)
            delete req.session.pending;
            res.redirect(303, location);
        },
    );

    // GET と POST 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'GET, POST').end();
    });

    return router;
}
