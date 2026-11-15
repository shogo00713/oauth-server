/**
 * Base64URL の指定したバイト数のランダム文字列を返す関数をまとめたファイル
 */

import crypto from 'node:crypto';

/**
 * Base64URL の指定したバイト数のランダム文字列を返す関数
 *
 * 文字列の長さは、指定したバイト数 * 4 / 3　の切り上げになる
 *
 * @param bytes : 作る文字列の元のバイト数
 * @returns ランダム文字列
 */
export function generateRandomString(bytes: number = 32): string {
    const MIN_BYTES = 16;

    // 引数のバリデーション
    if (typeof bytes !== 'number')
        throw new TypeError('bytes は数値を指定してください');
    if (bytes < MIN_BYTES)
        throw new RangeError('bytes は 16 以上を指定してください');
    if (!Number.isInteger(bytes))
        throw new RangeError('bytes は整数を指定してください');

    const rawbytes = crypto.randomBytes(bytes);
    return rawbytes.toString('base64url');
}
