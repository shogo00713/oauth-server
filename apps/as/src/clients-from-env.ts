import { z } from 'zod';
import { sha256Hex } from './lib/hash.js';
import { isValidRedirectUriFormat } from './lib/redirect-uri.js';
import type { Client } from './stores/client-store.js';

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

const schema = z.object({
    CLIENT_ID: z.preprocess(
        emptyAsUnset,
        z
            .string()
            .regex(/^[A-Za-z0-9_\-.~]+$/)
            .default('memoboard'),
    ),
    CLIENT_NAME: z.preprocess(emptyAsUnset, z.string().default('メモボード')),
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

export function loadClientsFromEnv(
    env: Record<string, string | undefined>,
): Client[] {
    const result = schema.safeParse(env);
    if (!result.success)
        throw new Error(
            `環境変数が不正です:\n${z.prettifyError(result.error)}`,
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
