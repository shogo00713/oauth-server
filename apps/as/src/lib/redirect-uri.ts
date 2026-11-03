/**
 * リダイレクト URL の検証を行う関数をまとめたファイル
 */

/**
 * 使用する(登録する) URL として適切な形をしているかどうかを調べる関数
 * @param uri : 検査したい URL
 * @returns boolean : 使用できる
 */
export function isValidRedirectUriFormat(uri: unknown): boolean {
    // 全体で使用できる文字と、スキームで使用できる形
    const ALLOWED_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
    const HTTP_PREFIX = /^https?:\/\//;

    if (typeof uri !== 'string') return false;
    if (!ALLOWED_CHARS.test(uri)) return false;
    if (!HTTP_PREFIX.test(uri)) return false;

    const u = URL.parse(uri);
    if (!u) return false;
    if (u.hash !== '' || uri.includes('#')) return false;
    if (u.username !== '' || u.password !== '') return false;
    if (u.hostname.includes('*')) return false;

    return true;
}

export function haveSameRedirectUri(
    requested: unknown,
    registered: unknown,
): boolean {
    if (typeof requested !== 'string') return false;
    if (!Array.isArray(registered)) return false;
    if (!requested) return false;
    if (registered.some((uri) => typeof uri !== 'string')) return false;
    // 登録済みURLとの完全一致を確認
    return registered.some((uri) => uri === requested);
}
