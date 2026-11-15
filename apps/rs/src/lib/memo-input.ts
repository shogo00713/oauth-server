/**
 * メモの作成、更新のリクエスト({ body })の入力検証(zod)
 *   docs/design/rs.md: body は文字列、1 文字以上、最大長あり
 */

import { z } from 'zod';

// body の最大の文字数(Unicode の文字の数。絵文字も 1 文字)
export const MAX_BODY_LENGTH = 10_000;

export type MemoInput = {
    body: string;
};

const schema = z.object({
    body: z
        .string()
        .min(1)
        .max(MAX_BODY_LENGTH)
        .refine((body) => body.isWellFormed()),
});

/**
 * リクエストの本文(JSON を読んだ物)を検証する
 * @returns 正しければ { body } だけの新しい物(知らない項目は、捨てる)。正しくなければ null
 */
export function parseMemoInput(raw: unknown): MemoInput | null {
    const result = schema.safeParse(raw);
    return result.success ? result.data : null;
}
