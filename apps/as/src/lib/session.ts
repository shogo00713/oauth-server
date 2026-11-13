import type { RequestHandler } from 'express';
import session from 'express-session';
import type { AuthzRequest } from './authz-request.js';

// セッションに入れる物
declare module 'express-session' {
    interface SessionData {
        // CSRF 対策のトークン(フォームに埋めて、送り返してもらう)
        csrfToken?: string;
        // ログインしたユーザーの ID
        userId?: string;
        // ログインや同意が終わるまで取っておく、認可リクエスト
        pending?: AuthzRequest;
    }
}

// Cookie の名前。client のセッションの Cookie と、別の名前にする
// (localhost では、ポートが違っても、Cookie が共有されるため)
export const SESSION_COOKIE_NAME = 'as_sid';

export const MIN_SESSION_SECRET_LENGTH = 32;
const DEFAULT_MAX_AGE_SEC = 30 * 60;

export type SessionOptions = {
    // Cookie の署名の秘密(32 文字以上)
    secret: string;
    // Secure 属性を付けるか(https で動かす時だけ true)
    secure: boolean;
    // セッションの寿命(秒)。省略すると 30 分
    maxAgeSec?: number | undefined;
};

export function createSessionMiddleware(
    options: SessionOptions,
): RequestHandler {
    if (typeof options.secret !== 'string') {
        throw new TypeError('secret は文字列を指定してください');
    }
    if (options.secret.length < MIN_SESSION_SECRET_LENGTH) {
        throw new RangeError(
            `secret は ${MIN_SESSION_SECRET_LENGTH} 文字以上を指定してください`,
        );
    }

    // 省略(undefined)した時だけ、既定値にする(null などは、型が違うので、下で弾く)
    const maxAgeSec =
        options.maxAgeSec === undefined
            ? DEFAULT_MAX_AGE_SEC
            : options.maxAgeSec;
    if (typeof maxAgeSec !== 'number') {
        throw new TypeError('maxAgeSec は数値を指定してください');
    }
    if (!Number.isInteger(maxAgeSec) || maxAgeSec <= 0) {
        throw new RangeError('maxAgeSec は 1 以上の整数を指定してください');
    }

    return session({
        name: SESSION_COOKIE_NAME,
        secret: options.secret,
        // 変更が無ければ、保存し直さない
        resave: false,
        // 何も入れていないセッションは、保存しない(Cookie も出さない)
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: options.secure,
            maxAge: maxAgeSec * 1000,
        },
    });
}
