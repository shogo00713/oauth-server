/**
 * AS のスコープに関する処理をまとめたファイル
 */

/**
 * 与えられた値を、綺麗なスコープの形にパースする関数
 * @param rawdata 何かわからん
 * @returns スコープの配列 or 不正な形式なら null で通知
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
 * リクエストされたスコープが、全て必要なスコープに収まっているかどうかの検証
 * @param requested リクエストされたスコープ
 * @param allowed 必要なスコープ
 * @returns 行けるか
 */
export function isSubsetScope(
    requested: readonly string[],
    allowed: readonly string[],
): boolean {
    if (requested.length === 0) return false;
    return new Set(requested).isSubsetOf(new Set(allowed));
}

/**
 * スコープのリストを、JWT に載せるように、半角スペースで繋げた一つの文字列に整形する関数
 * @param scopes スコープの文字列の配列
 * @returns 繋げた1つの文字列
 */
export function formatScope(scopes: readonly string[]): string {
    if (scopes.length === 0)
        throw new RangeError('スコープを1つ以上指定してください');
    return scopes.join(' ');
}
