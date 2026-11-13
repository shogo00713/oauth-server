/**
 * 認証・認可の失敗の返事(authenticate と requireScope で、共通)
 *   WWW-Authenticate ヘッダー(RFC 6750 3)と、JSON の本文を返す
 */
import type { Response } from 'express';
import {
    buildWwwAuthenticate,
    type BearerChallenge,
} from '../lib/www-authenticate.js';

// 本文の error_description に使う言葉。中身(理由)は、細かく教えない
export const AUTH_MESSAGES = {
    required: 'Authentication is required',
    malformed: 'The Authorization header is malformed',
    expired: 'The access token expired',
    invalid: 'The access token is invalid',
    insufficientScope:
        'The request requires higher privileges than provided by the access token',
} as const;

export function sendAuthError(
    res: Response,
    status: number,
    challenge: BearerChallenge,
    body: { error: string; error_description: string },
): void {
    res.set('WWW-Authenticate', buildWwwAuthenticate(challenge));
    res.status(status).json(body);
}
