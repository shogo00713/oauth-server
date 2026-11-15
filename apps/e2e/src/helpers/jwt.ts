/**
 * JWT の道具(結合テスト用)。node:crypto だけで作る
 *   - 読む、署名を確かめる: AS が出したトークンの中身を、外から確かめる
 *   - 作る: 偽物、期限切れ、宛先違いなど、「RS が断るべきトークン」を作る
 */
import {
    createHmac,
    createPrivateKey,
    createPublicKey,
    sign,
    verify,
} from 'node:crypto';

export type Json = Record<string, unknown>;

const encode = (value: Json | Buffer): string =>
    (Buffer.isBuffer(value)
        ? value
        : Buffer.from(JSON.stringify(value))
    ).toString('base64url');

export type DecodedJwt = {
    header: Json;
    payload: Json;
    signature: Buffer;
    // 署名の対象(ヘッダーと本体を、. でつないだ物)
    signingInput: string;
};

export function decodeJwt(token: string): DecodedJwt {
    const [header, payload, signature, ...rest] = token.split('.');
    if (!header || !payload || signature === undefined || rest.length > 0)
        throw new Error('JWT の形ではありません');
    return {
        header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Json,
        payload: JSON.parse(
            Buffer.from(payload, 'base64url').toString(),
        ) as Json,
        signature: Buffer.from(signature, 'base64url'),
        signingInput: `${header}.${payload}`,
    };
}

// RS256 の署名を、公開鍵(PEM)で確かめる
export function verifyRs256(token: string, publicKeyPem: string): boolean {
    const { signingInput, signature } = decodeJwt(token);
    return verify(
        'RSA-SHA256',
        Buffer.from(signingInput),
        createPublicKey(publicKeyPem),
        signature,
    );
}

export type MintOptions = {
    // 署名する、秘密鍵(PEM)
    privateKeyPem: string;
    issuer: string;
    audience: string;
    sub: string;
    scope: string;
    clientId?: string;
    // 発行からの有効期間(秒)。負の数なら、期限切れ
    expiresInSec?: number;
    // 上書きしたい、ヘッダーと本体(undefined を入れると、その項目を消す)
    header?: Record<string, unknown>;
    payload?: Record<string, unknown>;
};

const compact = (value: Record<string, unknown>): Json =>
    Object.fromEntries(
        Object.entries(value).filter(([, entry]) => entry !== undefined),
    );

// AS と同じ形(RFC 9068)の、アクセストークンを作る
export function mintAccessToken(options: MintOptions): string {
    const now = Math.floor(Date.now() / 1000);
    const header = compact({
        alg: 'RS256',
        typ: 'at+jwt',
        ...options.header,
    });
    const payload = compact({
        iss: options.issuer,
        aud: options.audience,
        sub: options.sub,
        client_id: options.clientId ?? 'memoboard',
        scope: options.scope,
        iat: now,
        exp: now + (options.expiresInSec ?? 300),
        ...options.payload,
    });
    const signingInput = `${encode(header)}.${encode(payload)}`;
    const signature = sign(
        'RSA-SHA256',
        Buffer.from(signingInput),
        createPrivateKey(options.privateKeyPem),
    );
    return `${signingInput}.${encode(signature)}`;
}

// 署名の無い JWT(alg=none)
export function unsignedToken(payload: Json): string {
    return `${encode({ alg: 'none', typ: 'at+jwt' })}.${encode(payload)}.`;
}

// 公開鍵を、HMAC の秘密として署名した JWT(alg=HS256。「アルゴリズムの取り違え」攻撃)
export function hmacTokenSignedWithPublicKey(
    payload: Json,
    publicKeyPem: string,
): string {
    const signingInput = `${encode({ alg: 'HS256', typ: 'at+jwt' })}.${encode(payload)}`;
    const signature = createHmac('sha256', publicKeyPem)
        .update(signingInput)
        .digest();
    return `${signingInput}.${encode(signature)}`;
}

// 本体だけを、差し替える(署名は、そのまま = もう合わない)
export function tamperPayload(token: string, changes: Json): string {
    const [header = '', payload = '', signature = ''] = token.split('.');
    const decoded = JSON.parse(
        Buffer.from(payload, 'base64url').toString(),
    ) as Json;
    return `${header}.${encode({ ...decoded, ...changes })}.${signature}`;
}
