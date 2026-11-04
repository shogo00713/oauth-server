import { formatScope } from './scope.js';
import { generateRandomString } from './random.js';
import type { KeyObject } from 'node:crypto';
import { SignJWT } from 'jose';

export type AccessTokenInput = {
    privateKey: CryptoKey | KeyObject;
    kid?: string | undefined;
    issuer: string;
    audience: string;
    subject: string;
    clientId: string;
    scope: readonly string[];
    ttlSec: number;
    now?: number | undefined;
};

export async function issueAccessToken(
    input: AccessTokenInput,
): Promise<string> {
    if (!input.issuer) throw new RangeError('issuer is required');
    if (!input.subject) throw new RangeError('subject is required');
    if (!input.audience) throw new RangeError('audience is required');
    if (!input.clientId) throw new RangeError('clientId is required');

    if (input.ttlSec <= 0 || !Number.isInteger(input.ttlSec))
        throw new RangeError('ttlSec must be a positive integer');
    if (!input.scope || input.scope.length === 0)
        throw new RangeError('scope must be non-empty');

    const scopeStr = formatScope(input.scope);

    let iat: number;
    if (input.now) {
        iat = input.now;
    } else {
        iat = Math.floor(Date.now() / 1000);
    }

    return await new SignJWT({
        client_id: input.clientId,
        scope: scopeStr,
    })
        .setProtectedHeader({
            alg: 'RS256',
            typ: 'at+jwt',
            ...(input.kid ? { kid: input.kid } : {}),
        })
        .setIssuer(input.issuer)
        .setSubject(input.subject)
        .setAudience(input.audience)
        .setIssuedAt(iat)
        .setExpirationTime(iat + input.ttlSec)
        .setJti(generateRandomString(32))
        .sign(input.privateKey);
}
