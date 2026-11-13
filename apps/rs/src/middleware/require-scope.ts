/**
 * 認可のミドルウェア: トークンのスコープが、そのルートの受け付ける物に入っているか
 *   RFC 6750 3.1: 足りなければ 403、error=insufficient_scope
 *   authenticate の後ろに置く
 */
import type { RequestHandler } from 'express';
import { hasAnyScope } from '../lib/scope.js';
import { buildWwwAuthenticate } from '../lib/www-authenticate.js';
import { AUTH_MESSAGES, sendAuthError } from './auth-error.js';

/**
 * @param realm WWW-Authenticate の realm
 * @param accepted 受け付けるスコープ(どれか 1 つで良い)。**弱い方を先頭に**書く
 *   足りない時の WWW-Authenticate の scope には、先頭の物を入れる
 */
export function requireScope(
    realm: string,
    accepted: readonly string[],
): RequestHandler {
    const [required] = accepted;
    // 設定の間違いは、リクエストが来てからではなく、作る時に気づく
    if (required === undefined)
        throw new RangeError('accepted must be non-empty');
    buildWwwAuthenticate({ realm, scope: [required] });

    return (req, res, next) => {
        const auth = req.auth;
        // authenticate を通っていない = コードの間違い。通さずに、エラーにする
        if (!auth)
            return next(
                new Error(
                    'requireScope は、authenticate の後ろに置いてください',
                ),
            );

        if (!hasAnyScope(auth.scope, accepted))
            return sendAuthError(
                res,
                403,
                {
                    realm,
                    scope: [required],
                    error: 'insufficient_scope',
                    errorDescription: AUTH_MESSAGES.insufficientScope,
                },
                {
                    error: 'insufficient_scope',
                    error_description: AUTH_MESSAGES.insufficientScope,
                },
            );

        next();
    };
}
