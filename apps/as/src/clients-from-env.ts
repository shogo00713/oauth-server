import { z } from 'zod';
import { sha256Hex } from './lib/hash.js';
import { isValidRedirectUriFormat } from './lib/redirect-uri.js';
import type { Client } from './stores/client-store.js';

const regexClinetId = /^[A-Za-z0-9_\-.~]+$/;

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

// クライアントID, クライアント名, クライアントシークレット, リダイレクトURIの環境変数の検証
const schema = z.object({
    CLIENT_ID: z.preprocess(emptyAsUnset, z.string().regex(regexClinetId)),
    CLIENT_NAME: z.preprocess(emptyAsUnset, z.string()),
    CLIENT_SECRET: z.preprocess(emptyAsUnset, z.string().min(32)),
    CLIENT_REDIRECT_URIS: z.preprocess(
        emptyAsUnset,
        z
            .string()
            .transform((value) => value.split(' '))
            .refine((uris) =>
                uris.every((uri) => isValidRedirectUriFormat(uri)),
            ),
    ),
});

/**
 * 環境変数から、登録済みクライアントの情報を読み込む関数
 *
 * zod でそれぞれ検証をしている
 *
 * @param env 環境変数全体, 特に必要なのは CLIENT_ID, CLIENT_NAME, CLIENT_SECRET, CLIENT_REDIRECT_URIS
 * @returns 登録済みクライアントの配列
 */
export function loadClientsFromEnv(
    env: Record<string, string | undefined>,
): Client[] {
    const result = schema.safeParse(env);
    if (!result.success)
        throw new Error(
            `--------------------------------\n
環境変数が不正です:\n
${z.prettifyError(result.error)}\n
--------------------------------`,
        );

    const values = result.data;
    return [
        {
            clientId: values.CLIENT_ID,
            secretHash: sha256Hex(values.CLIENT_SECRET),
            name: values.CLIENT_NAME,
            redirectUris: values.CLIENT_REDIRECT_URIS,
        },
    ];
}
