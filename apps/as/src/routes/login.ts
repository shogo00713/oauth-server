import express, { type Router } from 'express';
import { ensureCsrfToken, isValidCsrfToken } from '../lib/csrf.js';
import { sendErrorPage } from '../lib/page-errors.js';
import { readParam } from '../lib/params.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { generateRandomString } from '../lib/random.js';
import { noStore } from '../lib/security-headers.js';
import type { ClientStore } from '../stores/client-store.js';
import type { UserStore } from '../stores/user-store.js';

export type LoginDeps = {
    clientStore: ClientStore;
    userStore: UserStore;
};

// 画面に出す言葉
const MESSAGES = {
    noPending:
        '認可リクエストが見つかりません。アプリから、もう一度やり直してください',
    noClient:
        'アプリの情報を取得できませんでした。アプリから、もう一度やり直してください',
    badCsrf:
        'フォームの有効期限が切れたか、不正なリクエストです。アプリから、もう一度やり直してください',
    // ユーザー名が違う時も、パスワードが違う時も、同じ言葉にする
    loginFailed: 'ユーザー名かパスワードが違います',
} as const;

export function createLoginRouter(deps: LoginDeps): Router {
    const router = express.Router();

    // 画面や、リダイレクトを、キャッシュさせない
    router.use(noStore);

    // 存在しない username の時にも、本物と同じ重さのハッシュの確認を走らせるための、ダミーのハッシュ
    // (最初に必要になった時に、1 回だけ作る)
    let dummyHash: Promise<string> | undefined;
    const getDummyHash = () =>
        (dummyHash ??= hashPassword(generateRandomString()));

    router.get('/', async (req, res) => {
        const pending = req.session.pending;
        if (!pending) {
            return sendErrorPage(res, 400, MESSAGES.noPending);
        }
        if (req.session.userId) {
            return res.redirect(303, '/consent');
        }

        const client = await deps.clientStore.find(pending.clientId);
        if (!client) {
            return sendErrorPage(res, 400, MESSAGES.noClient);
        }

        res.render('login', {
            clientName: client.name,
            csrfToken: ensureCsrfToken(req.session),
            username: '',
            error: null,
        });
    });

    router.post(
        '/',
        express.urlencoded({ extended: false }),
        async (req, res) => {
            // 1. CSRF(パスワードを確かめる前に)
            if (
                !isValidCsrfToken(
                    req.session.csrfToken,
                    readParam(req.body, '_csrf'),
                )
            ) {
                return sendErrorPage(res, 403, MESSAGES.badCsrf);
            }

            // 2. 取っておいた認可リクエスト
            const pending = req.session.pending;
            if (!pending) {
                return sendErrorPage(res, 400, MESSAGES.noPending);
            }
            const client = await deps.clientStore.find(pending.clientId);
            if (!client) {
                return sendErrorPage(res, 400, MESSAGES.noClient);
            }

            // 3. ユーザー名とパスワード
            const username = readParam(req.body, 'username');
            const password = readParam(req.body, 'password');
            const user =
                typeof username === 'string'
                    ? await deps.userStore.findByUsername(username)
                    : null;

            // ユーザーが居なくても、ダミーのハッシュで確かめて、時間を揃える(結果は、使わない)
            const isValidPassword = await verifyPassword(
                password,
                user ? user.passwordHash : await getDummyHash(),
            );

            if (!user || !isValidPassword) {
                return res.render('login', {
                    clientName: client.name,
                    csrfToken: ensureCsrfToken(req.session),
                    username: typeof username === 'string' ? username : '',
                    error: MESSAGES.loginFailed,
                });
            }

            // 4. 成功: セッション ID を作り直して(固定化攻撃への対策)、中身を引き継ぐ
            await new Promise<void>((resolve, reject) => {
                req.session.regenerate((error) =>
                    error ? reject(error) : resolve(),
                );
            });
            req.session.pending = pending;
            req.session.userId = user.id;
            res.redirect(303, '/consent');
        },
    );

    // GET と POST 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'GET, POST').end();
    });

    return router;
}
