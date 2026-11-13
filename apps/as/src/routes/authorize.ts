import express, { type Router } from 'express';
import { parseAuthzRequest } from '../lib/authz-request.js';
import { buildAuthzErrorUrl } from '../lib/authz-response.js';
import { sendErrorPage } from '../lib/page-errors.js';
import { readParam } from '../lib/params.js';
import { noStore } from '../lib/security-headers.js';
import type { ClientStore } from '../stores/client-store.js';

export type AuthorizeDeps = {
    clientStore: ClientStore;
    // この AS が出せるスコープ
    supportedScopes: readonly string[];
    // scope が省略された時に使うスコープ
    defaultScope: readonly string[];
};

// client_id や redirect_uri がおかしい時に、画面に出す言葉
// (届いた値は、そのまま画面に出さない)
const PAGE_ERROR_MESSAGES = {
    invalid_client_id:
        'client_id が正しくありません。アプリの提供元に、問い合わせてください',
    invalid_redirect_uri:
        'redirect_uri が、登録されたものと一致しません。アプリの提供元に、問い合わせてください',
} as const;

export function createAuthorizeRouter(deps: AuthorizeDeps): Router {
    const router = express.Router();

    // 画面や、リダイレクトを、キャッシュさせない
    router.use(noStore);

    router.get('/', async (req, res) => {
        const clientId = readParam(req.query, 'client_id');
        const client =
            typeof clientId === 'string'
                ? await deps.clientStore.find(clientId)
                : null;

        const result = parseAuthzRequest(req.query, client, {
            supportedScopes: deps.supportedScopes,
            defaultScope: deps.defaultScope,
        });

        if (!result.ok) {
            // client_id や redirect_uri がおかしい時は、リダイレクトせずに、画面で知らせる
            if (result.kind === 'page') {
                return sendErrorPage(
                    res,
                    400,
                    PAGE_ERROR_MESSAGES[result.reason],
                );
            }

            return res.redirect(
                303,
                buildAuthzErrorUrl(result.redirectUri, {
                    error: result.error,
                    description: result.description,
                    state: result.state,
                }),
            );
        }

        // ログインと同意が終わるまで、取っておく
        req.session.pending = result.value;
        res.redirect(303, req.session.userId ? '/consent' : '/login');
    });

    // GET 以外は受け付けない
    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'GET').end();
    });

    return router;
}
