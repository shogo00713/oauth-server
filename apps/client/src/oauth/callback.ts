import { timingSafeEqual } from 'node:crypto';
import { readParam } from '../lib/params.js';

/**
 * /callback に戻ってきた、クエリの検査
 *   RFC 6749 4.1.2 / 4.1.2.1: code か error が来る。state は、送った物と、同じでなければならない
 *   docs/requirements/client.md の順番: ①知らないパラメータは無視 ②state を検証 ③error があれば伝える ④code を取り出す
 */

export type CallbackResult =
    // 認可コードが取れた
    | { kind: 'code'; code: string }
    // AS が、エラーを知らせてきた(拒否された、など)。description は、使える形の時だけ
    | { kind: 'error'; error: string; description?: string | undefined }
    // 信用できない、または形がおかしい。state_mismatch = state が、送った物と違う(または、無い)
    | { kind: 'invalid'; reason: 'state_mismatch' | 'malformed' };

// error と error_description に使える文字: %x20-21 / %x23-5B / %x5D-7E
const ERROR_CHARS = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;
// code に使える文字(RFC 6749 付録 A.11: VSCHAR = %x20-7E)
const CODE_CHARS = /^[\x20-\x7E]+$/;
// code の長さの上限(RFC に決まりは無いので、この client の決め)
const MAX_CODE_LENGTH = 512;

// 時間を測られても、中身が分からないように、比べる
function sameState(expected: string, actual: string): boolean {
    const a = Buffer.from(expected);
    const b = Buffer.from(actual);
    return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param query /callback のクエリ(req.query)
 * @param expectedState /login で、セッションに入れた state(無ければ undefined)
 */
export function parseCallback(
    query: unknown,
    expectedState: string | undefined,
): CallbackResult {
    // state が先。合わなければ、error も code も、信用しない(偽のエラーの表示も、防ぐ)
    const state = readParam(query, 'state');
    if (
        !expectedState ||
        typeof state !== 'string' ||
        !sameState(expectedState, state)
    )
        return { kind: 'invalid', reason: 'state_mismatch' };

    const error = readParam(query, 'error');
    const code = readParam(query, 'code');
    if (error === null || code === null)
        return { kind: 'invalid', reason: 'malformed' };

    if (error !== undefined) {
        // error と code が、両方来るのは、おかしい
        if (code !== undefined || !ERROR_CHARS.test(error))
            return { kind: 'invalid', reason: 'malformed' };

        const description = readParam(query, 'error_description');
        return {
            kind: 'error',
            error,
            ...(typeof description === 'string' && ERROR_CHARS.test(description)
                ? { description }
                : {}),
        };
    }

    if (
        code === undefined ||
        code.length > MAX_CODE_LENGTH ||
        !CODE_CHARS.test(code)
    )
        return { kind: 'invalid', reason: 'malformed' };

    return { kind: 'code', code };
}
