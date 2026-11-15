/**
 * セッションの中の、ログインの状態を読む
 */
import type { TokenSet } from '../oauth/token-request.js';

// 期限の、この秒数だけ前から、「期限切れ」として扱う(RS を呼んでいる間に、切れてしまうのを避ける)
export const TOKEN_LEEWAY_SEC = 30;

/**
 * 今使えるトークンを返す。無い、または期限切れなら undefined
 *   期限(expiresAt)が分からないトークンは、使える物として扱う
 *   セッションは、書き換えない
 * @param nowSec 今の時刻(秒。1970 年からの秒数)
 */
export function currentTokens(
    session: { tokens?: TokenSet | undefined },
    nowSec: number,
): TokenSet | undefined {
    const tokens = session.tokens;
    if (!tokens) return undefined;
    if (tokens.expiresAt === undefined) return tokens;
    return tokens.expiresAt - TOKEN_LEEWAY_SEC > nowSec ? tokens : undefined;
}
