/**
 * 認証のミドルウェア: Authorization ヘッダーのアクセストークンを検証して、req.auth に入れる
 *   RFC 6750 2.1 / 3 / 3.1、RFC 9068 4
 */
import type { KeyObject } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { VerifiedToken } from '../lib/verify-token.js';
import { extractBearerToken } from '../lib/bearer.js';
import { InvalidTokenError, verifyAccessToken } from '../lib/verify-token.js';
import { buildWwwAuthenticate } from '../lib/www-authenticate.js';
import { AUTH_MESSAGES, sendAuthError } from './auth-error.js';

declare global {
    namespace Express {
        interface Request {
            // 認証に成功したトークンの中身(authenticate の後ろで、使える)
            auth?: VerifiedToken | undefined;
        }
    }
}

export type AuthenticateOptions = {
    publicKey: CryptoKey | KeyObject;
    issuer: string;
    audience: string;
    // WWW-Authenticate の realm(保護領域の名前)
    realm: string;
    // 今の時刻(秒)を返す関数。リクエストのたびに呼ぶ。省略したら、本物の時計
    now?: (() => number) | undefined;
    clockToleranceSec?: number | undefined;
};

export function authenticate(options: AuthenticateOptions): RequestHandler {
    const { publicKey, issuer, audience, realm, now, clockToleranceSec } =
        options;
    // 設定の間違いは、リクエストが来てからではなく、作る時に気づく
    if (!issuer) throw new RangeError('issuer is required');
    if (!audience) throw new RangeError('audience is required');
    buildWwwAuthenticate({ realm });

    return async (req, res, next) => {
        const bearer = extractBearerToken(req.headers.authorization);

        // 認証情報が無い: error は付けない(RFC 6750 3)
        if (bearer.kind === 'none')
            return sendAuthError(
                res,
                401,
                { realm },
                {
                    error: 'unauthorized',
                    error_description: AUTH_MESSAGES.required,
                },
            );

        // Bearer なのに、形がおかしい
        if (bearer.kind === 'malformed')
            return sendAuthError(
                res,
                400,
                {
                    realm,
                    error: 'invalid_request',
                    errorDescription: AUTH_MESSAGES.malformed,
                },
                {
                    error: 'invalid_request',
                    error_description: AUTH_MESSAGES.malformed,
                },
            );

        try {
            req.auth = await verifyAccessToken(bearer.token, {
                publicKey,
                issuer,
                audience,
                now: now?.(),
                clockToleranceSec,
            });
        } catch (error) {
            // トークンのせいじゃない失敗(設定の間違いなど)は、401 にせず、エラー処理に任せる
            if (!(error instanceof InvalidTokenError)) throw error;

            const description =
                error.reason === 'expired'
                    ? AUTH_MESSAGES.expired
                    : AUTH_MESSAGES.invalid;
            return sendAuthError(
                res,
                401,
                {
                    realm,
                    error: 'invalid_token',
                    errorDescription: description,
                },
                { error: 'invalid_token', error_description: description },
            );
        }
        next();
    };
}
