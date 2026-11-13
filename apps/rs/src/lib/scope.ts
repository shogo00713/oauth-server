/**
 * RS のスコープに関する処理
 *   RFC 6749 3.3: スコープは、空白で区切った、大文字小文字を区別する文字列の並び
 *   (AS の scope.ts と同じ決まり。RS は別のアプリなので、自分で持つ)
 */

/**
 * トークンの scope の値(1 つの文字列)を、配列にする
 * @returns 重複を消して、並び替えた配列。形が正しくなければ null
 */
export function parseScope(rawdata: unknown): string[] | null {
    const regex = /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/;
    if (typeof rawdata !== 'string') return null;
    if (!regex.test(rawdata)) return null;

    const splited = rawdata.split(' ');
    const unique = [...new Set(splited)];
    const sorted = unique.sort();

    return sorted;
}

/**
 * トークンが持つスコープ(granted)に、受け付けるスコープ(accepted)の、どれか 1 つでも入っているか
 * 例: GET は ['read', 'write']、POST / PUT / DELETE は ['write'] を受け付ける
 */
export function hasAnyScope(
    granted: readonly string[],
    accepted: readonly string[],
): boolean {
    return accepted.some((scope) => granted.includes(scope));
}
