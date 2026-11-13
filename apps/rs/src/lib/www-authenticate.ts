/**
 * WWW-Authenticate ヘッダーの値を作る(Bearer 方式)
 *   RFC 6750 3: realm、scope、error、error_description
 *   値に使える文字は、RFC 6750 3 で決まっている(" と \ は使えない。制御文字も使えない)
 */
export type BearerErrorCode =
    'invalid_request' | 'invalid_token' | 'insufficient_scope';

export type BearerChallenge = {
    realm: string;
    error?: BearerErrorCode | undefined;
    errorDescription?: string | undefined;
    scope?: readonly string[] | undefined;
};

// realm と error_description に使える文字: %x20-21 / %x23-5B / %x5D-7E
const TEXT_VALUE = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;
// scope の 1 つ分に使える文字(空白は、区切りなので、含められない): %x21 / %x23-5B / %x5D-7E
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export function buildWwwAuthenticate(challenge: BearerChallenge): string {
    const { realm, error, errorDescription, scope } = challenge;

    if (!TEXT_VALUE.test(realm))
        throw new RangeError('realm に使えない文字が含まれています');
    if (errorDescription !== undefined) {
        if (error === undefined)
            throw new RangeError(
                'errorDescription は、error と一緒に指定してください',
            );
        if (!TEXT_VALUE.test(errorDescription))
            throw new RangeError(
                'errorDescription に使えない文字が含まれています',
            );
    }
    if (scope !== undefined) {
        if (scope.length === 0)
            throw new RangeError('scope は 1 つ以上指定してください');
        if (!scope.every((token) => SCOPE_TOKEN.test(token)))
            throw new RangeError('scope に使えない文字が含まれています');
    }

    // RFC 6750 3 に載っている順番: realm、scope、error、error_description
    const params = [`realm="${realm}"`];
    if (scope !== undefined) params.push(`scope="${scope.join(' ')}"`);
    if (error !== undefined) params.push(`error="${error}"`);
    if (errorDescription !== undefined)
        params.push(`error_description="${errorDescription}"`);

    return `Bearer ${params.join(', ')}`;
}
