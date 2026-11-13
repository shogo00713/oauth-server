/**
 * Authorization ヘッダーから、Bearer トークンを取り出す
 *   RFC 6750 2.1: credentials = "Bearer" 1*SP b64token
 *   RFC 9110 11.1: 認証方式の名前は、大文字小文字を区別しない
 */
export type BearerResult =
    // 認証情報が無い(ヘッダーが無い、空、または Bearer 以外の方式)
    | { kind: 'none' }
    // Bearer 方式なのに、形が正しくない
    | { kind: 'malformed' }
    | { kind: 'token'; token: string };

// b64token = 1*( ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" ) *"="
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;

export function extractBearerToken(header: string | undefined): BearerResult {
    if (header === undefined) return { kind: 'none' };

    // 最初の空白までが、方式の名前
    const spaceIndex = header.indexOf(' ');
    const scheme = spaceIndex === -1 ? header : header.slice(0, spaceIndex);
    if (scheme.toLowerCase() !== 'bearer') return { kind: 'none' };

    // 方式の名前の後ろの、空白(1 個以上)を飛ばした残りが、トークン
    const token =
        spaceIndex === -1 ? '' : header.slice(spaceIndex).replace(/^ +/, '');
    if (!B64TOKEN.test(token)) return { kind: 'malformed' };

    return { kind: 'token', token };
}
