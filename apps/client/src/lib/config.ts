/**
 * client(メモボード)の設定(環境変数)の読み込みと、検証(zod)
 */
import { z } from 'zod';
import { MIN_SESSION_SECRET_LENGTH } from './session.js';

export type Config = {
    baseUrl: string; // この client の URL
    port: number;
    asBaseUrl: string; // AS の URL
    rsBaseUrl: string; // RS の URL
    clientId: string;
    clientSecret: string;
    sessionSecret: string;
    requestedScope: string;
    redirectUri: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
};

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

// URL の形: http か https で、末尾に / が無く、クエリもフラグメントも無い(パスは、あっても良い)
const urlSchema = z
    .url({ protocol: /^https?$/ })
    .refine((value) => !value.endsWith('/'), '末尾に / を付けないでください')
    .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return url.search === '' && url.hash === '';
    }, 'クエリとフラグメントは付けないでください');

// この client の URL は、パスなし(/callback などの道が、その直下に、あるため)
const baseUrlSchema = urlSchema.refine((value) => {
    if (!URL.canParse(value)) return false;
    return new URL(value).pathname === '/';
}, 'パスは付けないでください(例: http://localhost:4001)');

const scopeSchema = z
    .string()
    .regex(
        /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/,
        'スコープの形式が不正です(空白 1 つ区切り)',
    )
    .default('read write');

const schema = z.object({
    BASE_URL: z.preprocess(emptyAsUnset, baseUrlSchema),
    PORT: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(65535)),
    AS_BASE_URL: z.preprocess(emptyAsUnset, urlSchema),
    RS_BASE_URL: z.preprocess(emptyAsUnset, urlSchema),
    CLIENT_ID: z.preprocess(
        emptyAsUnset,
        z
            .string()
            .regex(/^[A-Za-z0-9_\-.~]+$/)
            .default('memoboard'),
    ),
    CLIENT_SECRET: z.preprocess(emptyAsUnset, z.string().min(32)),
    SESSION_SECRET: z.preprocess(
        emptyAsUnset,
        z.string().min(MIN_SESSION_SECRET_LENGTH),
    ),
    REQUESTED_SCOPE: z.preprocess(emptyAsUnset, scopeSchema),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
    const result = schema.safeParse(env);
    if (!result.success)
        throw new Error(
            `環境変数が不正です:\n${z.prettifyError(result.error)}`,
        );

    const values = result.data;
    return {
        baseUrl: values.BASE_URL,
        port: values.PORT,
        asBaseUrl: values.AS_BASE_URL,
        rsBaseUrl: values.RS_BASE_URL,
        clientId: values.CLIENT_ID,
        clientSecret: values.CLIENT_SECRET,
        sessionSecret: values.SESSION_SECRET,
        requestedScope: values.REQUESTED_SCOPE,
        redirectUri: `${values.BASE_URL}/callback`,
        authorizationEndpoint: `${values.AS_BASE_URL}/authorize`,
        tokenEndpoint: `${values.AS_BASE_URL}/token`,
    };
}
