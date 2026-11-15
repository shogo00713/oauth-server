import { generateRandomString } from './random.js';

/**
 * CSRFトークンを発行する関数
 * @returns Base64urlで43文字の CSRFトークン
 */
export function generateCsrfToken(): string {
    return generateRandomString();
}

/**
 * 2つのCSRFトークンを受け取り、それらが正しく一致するかを判定する関数
 * @param expected 来るはずのトークン
 * @param actual 実際に来たトークン
 * @returns boolean
 */
export function isValidCsrfToken(expected: unknown, actual: unknown): boolean {
    if (typeof expected !== 'string' || typeof actual !== 'string')
        return false;
    if (!expected || !actual) return false;
    if (expected === actual) return true;
    else return false;
}

export function ensureCsrfToken(session: {
    csrfToken?: string | undefined;
}): string {
    if (session.csrfToken && typeof session.csrfToken === 'string') {
        return session.csrfToken;
    } else {
        session.csrfToken = generateCsrfToken();
        return session.csrfToken;
    }
}
