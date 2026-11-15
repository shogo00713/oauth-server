import express, { type Router } from 'express';
import { respondWithFailure } from '../lib/api-failure.js';
import { currentTokens } from '../lib/auth-session.js';
import { ensureCsrfToken, isValidCsrfToken } from '../lib/csrf.js';
import {
    FORM_BODY_LIMIT,
    parseMemoBody,
    parseSearchQuery,
} from '../lib/memo-form.js';
import { searchMemos } from '../lib/memo-search.js';
import { sortNewestFirst } from '../lib/memo-sort.js';
import { sendErrorPage } from '../lib/page-errors.js';
import { readParam } from '../lib/params.js';
import { noStore } from '../lib/security-headers.js';
import { resetSession } from '../lib/session-reset.js';
import type { MemoApi } from '../rs/memo-api.js';

export type HomeDeps = {
    memoApi: MemoApi;
    // 今の時刻(秒)を返す関数。テストで差し替えられる。省略したら、本物の時計
    now?: (() => number) | undefined;
};

// 画面に出す言葉
const MESSAGES = {
    expired: 'ログインの有効期限が切れました。もう一度、ログインしてください',
    badCsrf:
        'フォームの有効期限が切れたか、不正なリクエストです。トップに戻って、もう一度やり直してください',
    badQuery: '検索語が正しくありません',
    malformed: 'リクエストが正しくありません',
    emptyBody: 'メモの本文を入力してください',
    tooLong: 'メモは 10000 文字までです',
    created: 'メモを追加しました',
} as const;

/**
 * GET /: ログイン前なら、ログインを促す画面。ログイン後なら、メモの一覧(検索つき)
 * POST /: メモを作る
 */
export function createHomeRouter(deps: HomeDeps): Router {
    const router = express.Router();
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    // 一覧には、メモの中身と、フォームのトークンがある。キャッシュさせない
    router.use(noStore);

    router.get('/', async (req, res) => {
        // 次の画面に出す、メッセージ。取り出して、消す(1 回だけ出す)
        const flash = req.session.flash;
        delete req.session.flash;

        const tokens = currentTokens(req.session, now());
        if (!tokens) {
            // 期限切れのトークンが残っていれば、セッションごと捨てる
            if (req.session.tokens) {
                await resetSession(req);
                return res.render('welcome', { flash: MESSAGES.expired });
            }
            return res.render('welcome', { flash });
        }

        const parsed = parseSearchQuery(readParam(req.query, 'q'));
        if (!parsed.ok) {
            return sendErrorPage(res, 400, MESSAGES.badQuery);
        }

        const result = await deps.memoApi.list(tokens.accessToken);
        if (!result.ok) {
            return respondWithFailure(req, res, result.failure);
        }

        res.render('list', {
            memos: searchMemos(sortNewestFirst(result.data), parsed.query),
            query: parsed.query,
            csrfToken: ensureCsrfToken(req.session),
            flash,
        });
    });

    router.post(
        '/',
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

            // 3. 本文
            const parsed = parseMemoBody(readParam(req.body, 'body'));
            if (!parsed.ok) {
                if (parsed.reason === 'malformed') {
                    return sendErrorPage(res, 400, MESSAGES.malformed);
                }
                req.session.flash =
                    parsed.reason === 'empty'
                        ? MESSAGES.emptyBody
                        : MESSAGES.tooLong;
                return res.redirect(303, '/');
            }

            // 4. RS に作ってもらう
            const result = await deps.memoApi.create(
                tokens.accessToken,
                parsed.body,
            );
            if (!result.ok) {
                return respondWithFailure(req, res, result.failure);
            }

            // 画面を開き直しても、二重に作らないように、リダイレクトで戻す
            req.session.flash = MESSAGES.created;
            res.redirect(303, '/');
        },
    );

    // GET と POST 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'GET, POST').end();
    });

    return router;
}
