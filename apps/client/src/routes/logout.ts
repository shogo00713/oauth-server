import express, { type Router } from 'express';
import { isValidCsrfToken } from '../lib/csrf.js';
import { sendErrorPage } from '../lib/page-errors.js';
import { readParam } from '../lib/params.js';
import { noStore } from '../lib/security-headers.js';
import { resetSession } from '../lib/session-reset.js';

// 画面に出す言葉
const MESSAGES = {
    badCsrf:
        'フォームの有効期限が切れたか、不正なリクエストです。トップに戻って、もう一度やり直してください',
    loggedOut: 'ログアウトしました',
} as const;

/**
 * POST /logout: セッションを捨てる(トークンも消える)
 *   AS 側のセッションは、残る(すぐ再ログインしても、AS のログイン画面は出ない)
 */
export function createLogoutRouter(): Router {
    const router = express.Router();

    router.use(noStore);

    router.post(
        '/',
        express.urlencoded({ extended: false }),
        async (req, res) => {
            // CSRF(他のサイトから、勝手にログアウトさせられない)
            if (
                !isValidCsrfToken(
                    req.session.csrfToken,
                    readParam(req.body, '_csrf'),
                )
            ) {
                return sendErrorPage(res, 403, MESSAGES.badCsrf);
            }

            await resetSession(req, MESSAGES.loggedOut);
            res.redirect(303, '/');
        },
    );

    // POST 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'POST').end();
    });

    return router;
}
