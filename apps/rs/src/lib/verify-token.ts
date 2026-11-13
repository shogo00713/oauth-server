/**
 * アクセストークン(JWT)の検証
 *   RFC 9068 4: typ、iss、aud、署名と alg、exp を確かめる(MUST)
 *   RFC 8725 3.1: 受け付ける alg は、こちらで決める(トークンの alg は、信用しない)
 */
import type { KeyObject } from 'node:crypto';
import { errors, jwtVerify } from 'jose';
import { parseScope } from './scope.js';

// 検証に失敗した理由
export type InvalidTokenReason =
    // JWT として読めない(形、base64url、JSON、暗号化されたトークン、知らない crit など)
    | 'malformed'
    | 'bad_algorithm'
    | 'bad_type'
    | 'bad_signature'
    | 'expired'
    | 'not_yet_valid'
    | 'bad_issuer'
    | 'bad_audience'
    // sub、client_id、scope、exp などが、無い、または形が正しくない
    | 'bad_claims';

export class InvalidTokenError extends Error {
    readonly reason: InvalidTokenReason;

    constructor(reason: InvalidTokenReason, options?: ErrorOptions) {
        super(`invalid token: ${reason}`, options);
        this.name = 'InvalidTokenError';
        this.reason = reason;
    }
}

export type VerifiedToken = {
    // ログインした人(メモの持ち主)
    sub: string;
    clientId: string;
    scope: string[];
};

export type VerifyOptions = {
    publicKey: CryptoKey | KeyObject;
    issuer: string;
    audience: string;
    // 今の時刻(秒)。省略したら、本物の時計。テストで差し替えられる
    now?: number | undefined;
    // 時計のずれを許す秒数(exp と nbf に効く)。省略したら 0
    clockToleranceSec?: number | undefined;
};

// jose のエラーを、InvalidTokenError に変える。トークンのせいじゃない物(鍵の種類の間違いなど)は、そのまま返す
function toInvalidTokenError(error: unknown): unknown {
    // JWTExpired は JWTClaimValidationFailed の仲間なので、先に調べる
    if (error instanceof errors.JWTExpired)
        return new InvalidTokenError('expired', { cause: error });

    if (error instanceof errors.JWTClaimValidationFailed) {
        const reasons: Record<string, InvalidTokenReason> = {
            nbf: 'not_yet_valid',
            iss: 'bad_issuer',
            aud: 'bad_audience',
            typ: 'bad_type',
        };
        return new InvalidTokenError(reasons[error.claim] ?? 'bad_claims', {
            cause: error,
        });
    }
    if (error instanceof errors.JOSEAlgNotAllowed)
        return new InvalidTokenError('bad_algorithm', { cause: error });
    if (error instanceof errors.JWSSignatureVerificationFailed)
        return new InvalidTokenError('bad_signature', { cause: error });
    if (
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JOSENotSupported
    )
        return new InvalidTokenError('malformed', { cause: error });

    return error;
}

export async function verifyAccessToken(
    token: string,
    options: VerifyOptions,
): Promise<VerifiedToken> {
    // 空だと、何でも通してしまう設定になりかねないので、確かめずに断る
    if (!options.issuer) throw new RangeError('issuer is required');
    if (!options.audience) throw new RangeError('audience is required');

    const nowSec = options.now ?? Math.floor(Date.now() / 1000);

    let payload;
    try {
        ({ payload } = await jwtVerify(token, options.publicKey, {
            algorithms: ['RS256'],
            typ: 'at+jwt',
            issuer: options.issuer,
            audience: options.audience,
            currentDate: new Date(nowSec * 1000),
            clockTolerance: options.clockToleranceSec ?? 0,
            requiredClaims: ['exp'],
        }));
    } catch (error) {
        throw toInvalidTokenError(error);
    }

    const { sub, client_id: clientId, scope } = payload;
    const parsedScope = parseScope(scope);
    if (typeof sub !== 'string' || sub === '')
        throw new InvalidTokenError('bad_claims');
    if (typeof clientId !== 'string' || clientId === '')
        throw new InvalidTokenError('bad_claims');
    if (parsedScope === null) throw new InvalidTokenError('bad_claims');

    return { sub, clientId, scope: parsedScope };
}
