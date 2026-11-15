import express, { type Request, type Router } from 'express';
import { respondWithFailure } from '../lib/api-failure.js';
import { currentTokens } from '../lib/auth-session.js';
import { ensureCsrfToken, isValidCsrfToken } from '../lib/csrf.js';
import { FORM_BODY_LIMIT, parseMemoBody } from '../lib/memo-form.js';
import { sendErrorPage } from '../lib/page-errors.js';
import { readParam } from '../lib/params.js';
import { noStore } from '../lib/security-headers.js';
import { resetSession } from '../lib/session-reset.js';
import type { MemoApi } from '../rs/memo-api.js';

export type DetailDeps = {
    memoApi: MemoApi;
    // 今の時刻(秒)を返す関数。テストで差し替えられる。省略したら、本物の時計
    now?: (() => number) | undefined;
};

// 画面に出す言葉
const MESSAGES = {
    expired: 'ログインの有効期限が切れました。もう一度、ログインしてください',
    badCsrf:
        'フォームの有効期限が切れたか、不正なリクエストです。トップに戻って、もう一度やり直してください',
    malformed: 'リクエストが正しくありません',
    emptyBody: 'メモの本文を入力してください',
    tooLong: 'メモは 10000 文字までです',
    saved: 'メモを保存しました',
    deleted: 'メモを削除しました',
} as const;

// URL の :id(Express が、%XX を戻した後の値)
const idOf = (req: Request): string => String(req.params['id']);

// そのメモの画面の道(id は、URL として安全な形にする)
const detailPath = (id: string): string => `/detail/${encodeURIComponent(id)}`;

/**
 * GET /detail/:id: メモの表示(編集、削除のフォームつき)
 * POST /detail/:id: 保存(action=update)、削除(action=delete)
 */
export function createDetailRouter(deps: DetailDeps): Router {
    const router = express.Router();
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    // メモの中身と、フォームのトークンがある。キャッシュさせない
    router.use(noStore);

    router.get('/:id', async (req, res) => {
        const tokens = currentTokens(req.session, now());
        if (!tokens) {
            // 期限切れのトークンが残っていれば、セッションごと捨てる(メッセージ付き)
            if (req.session.tokens) {
                await resetSession(req, MESSAGES.expired);
            }
            return res.redirect(303, '/');
        }

        // 次の画面に出す、メッセージ。取り出して、消す(1 回だけ出す)
        const flash = req.session.flash;
        delete req.session.flash;

        const result = await deps.memoApi.get(tokens.accessToken, idOf(req));
        if (!result.ok) {
            return respondWithFailure(req, res, result.failure);
        }

        res.render('detail', {
            memo: result.data,
            csrfToken: ensureCsrfToken(req.session),
            flash,
        });
    });

    router.post(
        '/:id',
        express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }),
        async (req, res) => {
            // 1. CSRF
            if (
                !isValidCsrfToken(
                    req.session.csrfToken,
                    readParam(req.body, '_csrf'),
                )
            ) {
                return sendErrorPage(res, 403, MESSAGES.badCsrf);
            }

            // 2. ログインしているか(トークンが無い、または期限切れなら、セッションを捨てて、トップへ)
            const tokens = currentTokens(req.session, now());
            if (!tokens) {
                await resetSession(req, MESSAGES.expired);
                return res.redirect(303, '/');
            }

            const id = idOf(req);
            const action = readParam(req.body, 'action');

            // 3. 削除
            if (action === 'delete') {
                const result = await deps.memoApi.delete(
                    tokens.accessToken,
                    id,
                );
                if (!result.ok) {
                    return respondWithFailure(req, res, result.failure);
                }
                req.session.flash = MESSAGES.deleted;
                // もう無いメモの画面には、戻れない。一覧へ
                return res.redirect(303, '/');
            }

            // 4. 保存
            if (action === 'update') {
                const parsed = parseMemoBody(readParam(req.body, 'body'));
                if (!parsed.ok) {
                    if (parsed.reason === 'malformed') {
                        return sendErrorPage(res, 400, MESSAGES.malformed);
                    }
                    req.session.flash =
                        parsed.reason === 'empty'
                            ? MESSAGES.emptyBody
                            : MESSAGES.tooLong;
                    return res.redirect(303, detailPath(id));
                }

                const result = await deps.memoApi.update(
                    tokens.accessToken,
                    id,
                    parsed.body,
                );
                if (!result.ok) {
                    return respondWithFailure(req, res, result.failure);
                }
                req.session.flash = MESSAGES.saved;
                // 画面を開き直しても、二重に送らないように、リダイレクトで戻す
                return res.redirect(303, detailPath(id));
            }

            // action が、無い、2 つある、知らない値
            return sendErrorPage(res, 400, MESSAGES.malformed);
        },
    );

    // GET と POST 以外は受け付けない
    router.all('/:id', (_req, res) => {
        res.status(405).set('Allow', 'GET, POST').end();
    });

    return router;
}
