/**
 * フォームから届いた、メモの本文と、検索語を読む
 *   長さは、RS と同じく、Unicode の文字の数で数える(絵文字も 1 文字)
 */

// メモの本文の、最大の文字数(RS の MAX_BODY_LENGTH と同じ)
export const MAX_BODY_LENGTH = 10_000;
// 検索語の、最大の文字数
export const MAX_QUERY_LENGTH = 200;

// フォームの送り状(application/x-www-form-urlencoded)の、大きさの上限
// 1 文字が 4 バイトの文字(絵文字など)は、%XX%XX%XX%XX の 12 バイトになる。
// 10000 文字ちょうどの本文が、12 万バイトになっても入る大きさにする(Express の既定の 100kb では、足りない)
export const FORM_BODY_LIMIT = '128kb';

const countCharacters = (text: string): number => Array.from(text).length;

export type BodyResult =
    | { ok: true; body: string }
    // malformed = 文字列じゃない(2 回ある、など)。empty = 無い、または空白だけ。too_long = 長すぎる
    | { ok: false; reason: 'malformed' | 'empty' | 'too_long' };

/**
 * @param value readParam(req.body, 'body') の結果(null = 文字列じゃない、undefined = 無い、または空)
 * @returns 改行を LF にそろえた本文。前後の空白は、そのまま残す
 */
export function parseMemoBody(value: string | undefined | null): BodyResult {
    if (value === null) return { ok: false, reason: 'malformed' };
    if (value === undefined) return { ok: false, reason: 'empty' };

    // ブラウザは、textarea の改行を CRLF で送ってくる
    const body = value.replace(/\r\n?/g, '\n');
    if (body.trim() === '') return { ok: false, reason: 'empty' };
    if (countCharacters(body) > MAX_BODY_LENGTH)
        return { ok: false, reason: 'too_long' };
    return { ok: true, body };
}

export type QueryResult = { ok: true; query: string } | { ok: false };

/**
 * @param value readParam(req.query, 'q') の結果(null = 文字列じゃない、undefined = 無い、または空)
 * @returns 前後の空白を取った検索語(無ければ空文字)
 */
export function parseSearchQuery(
    value: string | undefined | null,
): QueryResult {
    if (value === null) return { ok: false };
    const query = (value ?? '').trim();
    if (countCharacters(query) > MAX_QUERY_LENGTH) return { ok: false };
    return { ok: true, query };
}
