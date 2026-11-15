/**
 * RS の設定(環境変数)の読み込みと、検証(zod)
 */

import { z } from 'zod';

export type Config = {
    // AS の issuer。トークンの iss と、一字一句同じ値にする
    issuer: string;
    port: number;
    // この RS の名前。トークンの aud に、これが入っていること。WWW-Authenticate の realm にも使う
    audience: string;
    // AS の公開鍵(PEM)のファイルの場所
    verifyKeyPath: string;
    // 時計のずれを許す秒数
    clockToleranceSec: number;
    // メモを入れる SQLite のファイルの場所(':memory:' なら、メモリの上だけ)
    dbPath: string;
};

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

// issuer 用の特別処理(AS と同じ決まり)
const issuerSchema = z
    .url({ protocol: /^https?$/ })
    .refine((value) => !value.endsWith('/'), '末尾に / を付けないでください')
    .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return url.search === '' && url.hash === '';
    }, 'クエリとフラグメントは付けないでください');

// WWW-Authenticate の realm に入れられる文字だけ(" と \ と制御文字は、使えない)
const audienceSchema = z
    .string()
    .regex(
        /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/,
        '" と \\ と、制御文字と、ASCII 以外は、使えません',
    )
    .default('simple-memo');

const schema = z.object({
    ISSUER: z.preprocess(emptyAsUnset, issuerSchema),
    PORT: z.preprocess(emptyAsUnset, z.coerce.number().int().min(1).max(65535)),
    VERIFY_KEY_PATH: z.preprocess(emptyAsUnset, z.string()),
    AUDIENCE: z.preprocess(emptyAsUnset, audienceSchema),
    CLOCK_TOLERANCE_SEC: z.preprocess(
        emptyAsUnset,
        z.coerce.number().int().min(0).max(300).default(0),
    ),
    DB_PATH: z.preprocess(emptyAsUnset, z.string()),
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
        verifyKeyPath: values.VERIFY_KEY_PATH,
        clockToleranceSec: values.CLOCK_TOLERANCE_SEC,
        dbPath: values.DB_PATH,
    };
}
