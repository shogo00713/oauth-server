import { z } from 'zod';
import { parseScope } from './scope.js';

export type Config = {
    issuer: string;
    port: number;
    audience: string;
    signingKeyPath: string;
    codeTtlSec: number;
    accessTokenTtlSec: number;
    defaultScope: string[];
};

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

// issuer用の特別処理
const issuerSchema = z
    .url({ protocol: /^https?$/ })
    .refine((value) => !value.endsWith('/'), '末尾に / を付けないでください')
    .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return url.search === '' && url.hash === '';
    }, 'クエリとフラグメントは付けないでください');

// scope用の特別処理
const scopeSchema = z
    .string()
    .default('read')
    .refine((value) => parseScope(value) !== null, 'スコープの形式が不正です')
    .transform((value) => parseScope(value) ?? []);

const schema = z.object({
    ISSUER: z.preprocess(emptyAsUnset, issuerSchema),
    PORT: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(65535)),
    SIGNING_KEY_PATH: z.preprocess(emptyAsUnset, z.string()),
    AUDIENCE: z.preprocess(emptyAsUnset, z.string().default('simple-memo')),
    CODE_TTL_SEC: z.preprocess(
        emptyAsUnset,
        z.coerce.number().int().positive().default(60),
    ),
    ACCESS_TOKEN_TTL_SEC: z.preprocess(
        emptyAsUnset,
        z.coerce.number().int().positive().default(600),
    ),
    DEFAULT_SCOPE: z.preprocess(emptyAsUnset, scopeSchema),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
    const result = schema.safeParse(env);
    if (!result.success)
        throw new Error(
            `環境変数が不正です:\n${z.prettifyError(result.error)}`,
        );

    const values = result.data;
    return {
        issuer: values.ISSUER,
        port: values.PORT,
        audience: values.AUDIENCE,
        signingKeyPath: values.SIGNING_KEY_PATH,
        codeTtlSec: values.CODE_TTL_SEC,
        accessTokenTtlSec: values.ACCESS_TOKEN_TTL_SEC,
        defaultScope: values.DEFAULT_SCOPE,
    };
}
