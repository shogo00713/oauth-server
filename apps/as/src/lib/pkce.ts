/**
 * PKCE に関する検査・判定の関数をまとめたファイル
 */

import crypto from 'node:crypto';

/**
 * 有効な形式の code_berifier かどうかを調べる関数
 * @param code_verifier
 * @returns boolean
 */
export function isValidCodeVerifier(code_verifier: unknown): boolean {
    if (typeof code_verifier !== 'string') return false;
    const regex = /^[A-Za-z0-9_\-.~]{43,128}$/;
    return regex.test(code_verifier);
}

/**
 * 有効な形式の code_challenge かどうかを調べる関数
 * @param code_challenge
 * @returns boolean
 */
export function isValidCodeChallenge(code_challenge: string): boolean {
    if (typeof code_challenge !== 'string') return false;
    const regex = /^[A-Za-z0-9_-]{43}$/;
    return regex.test(code_challenge);
}

/**
 * code_verifier から code_challenge を計算する関数
 *
 * ここでは、code_verifirer の形式の検査はしてないので、有効なものを与えること
 *
 * @param code_verifier : 文字列
 * @returns code_challenge : 文字列
 */
export function computeCodeChallenge(code_verifier: string) {
    const ascii_code_verifier = Buffer.from(code_verifier, 'ascii');
    const bytes_code_challenge = crypto
        .createHash('sha256')
        .update(ascii_code_verifier);
    return bytes_code_challenge.digest('base64url');
}

/**
 * code_verifier と code_challenge を渡して、それらが一致するものなのかを調べる関数
 *
 * 同時に内部で、有効な形式なのかの検証もする
 *
 * @param code_verifier : 今与えられた code_verfirer
 * @param pre_code_challenge : 事前に与えられた code_challenge
 * @returns boolean : 一致するものだったかどうか
 */
export function verifyCodeChallenge(
    code_verifier: string,
    pre_code_challenge: string,
): boolean {
    if (!isValidCodeChallenge(pre_code_challenge)) return false;
    if (!isValidCodeVerifier(code_verifier)) return false;

    // code_challenge を計算
    const now_code_challenge = computeCodeChallenge(code_verifier);

    // Buffer に変換
    const useBufferNow = Buffer.from(now_code_challenge);
    const useBufferPre = Buffer.from(pre_code_challenge);

    return crypto.timingSafeEqual(useBufferNow, useBufferPre);
}
