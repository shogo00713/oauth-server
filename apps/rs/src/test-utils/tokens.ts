/**
 * テスト用に、アクセストークン(JWT)を作る道具(テスト専用)
 *   正しいトークンも、わざと壊したトークンも、ここで作る
 *   AS のコードは使わない(RS は、AS と別のアプリ。仕様どおりの形を、自分で作る)
 */
import {
    constants,
    createHmac,
    generateKeyPairSync,
    sign,
    type KeyObject,
} from 'node:crypto';

export const TEST_ISSUER = 'http://localhost:4000';
export const TEST_AUDIENCE = 'simple-memo';
// テストの中の「今」(秒)。トークンは、これの時に発行されたことにする
export const TEST_NOW = 1_800_000_000;
export const TEST_TTL_SEC = 600;

export type TestKeyPair = {
    privateKey: KeyObject;
    publicKey: KeyObject;
    // 公開鍵の PEM(SPKI)。RS が読み込む形
    publicPem: string;
};

export function createTestKeyPair(modulusLength = 2048): TestKeyPair {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength,
    });
    return {
        privateKey,
        publicKey,
        publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
}

export const base64url = (value: unknown): string =>
    Buffer.from(
        typeof value === 'string' ? value : JSON.stringify(value),
    ).toString('base64url');

export type Parts = Record<string, unknown>;

// 正しいトークンの、標準の claim
export const defaultClaims = (): Parts => ({
    iss: TEST_ISSUER,
    aud: TEST_AUDIENCE,
    sub: 'user-1',
    client_id: 'memoboard',
    scope: 'read',
    iat: TEST_NOW,
    exp: TEST_NOW + TEST_TTL_SEC,
    jti: 'jti-1',
});

// 標準の header
export const defaultHeader = (): Parts => ({ alg: 'RS256', typ: 'at+jwt' });

// 上書き。値が undefined の項目は、消す
const applyOverrides = (defaults: Parts, overrides: Parts = {}): Parts => {
    const merged = { ...defaults, ...overrides };
    for (const key of Object.keys(merged))
        if (merged[key] === undefined) delete merged[key];
    return merged;
};

// 署名を作る(header の alg に合わせる。対応: RS256、RS384、PS256)
function signInput(alg: unknown, input: string, privateKey: KeyObject) {
    const data = Buffer.from(input);
    if (alg === 'PS256')
        return sign('sha256', data, {
            key: privateKey,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
        }).toString('base64url');
    return sign(
        alg === 'RS384' ? 'sha384' : 'sha256',
        data,
        privateKey,
    ).toString('base64url');
}

// header と、payload(文字列のまま)から、署名つきの JWT を作る
export function signCompact(
    privateKey: KeyObject,
    header: Parts,
    payload: string,
): string {
    const input = `${base64url(header)}.${base64url(payload)}`;
    return `${input}.${signInput(header['alg'], input, privateKey)}`;
}

export type TokenSpec = {
    // 標準の header の、上書き(undefined なら、その項目を消す)
    header?: Parts;
    // 標準の claim の、上書き(undefined なら、その項目を消す)
    claims?: Parts;
};

// 署名つきのアクセストークンを作る
export function signToken(privateKey: KeyObject, spec: TokenSpec = {}): string {
    return signCompact(
        privateKey,
        applyOverrides(defaultHeader(), spec.header),
        JSON.stringify(applyOverrides(defaultClaims(), spec.claims)),
    );
}

// 署名の無いトークン(alg: none など)。signature には、好きな文字列を入れられる
export function unsignedToken(spec: TokenSpec = {}, signature = ''): string {
    return `${base64url(applyOverrides(defaultHeader(), spec.header))}.${base64url(applyOverrides(defaultClaims(), spec.claims))}.${signature}`;
}

// HS256 で、「秘密」に、公開鍵の PEM を使って署名したトークン(アルゴリズムの取り違え攻撃)
export function hs256Token(secret: string, spec: TokenSpec = {}): string {
    const header = applyOverrides(
        { ...defaultHeader(), alg: 'HS256' },
        spec.header,
    );
    const input = `${base64url(header)}.${base64url(applyOverrides(defaultClaims(), spec.claims))}`;
    return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}
