import { formatScope } from './scope.js';

export type TokenErrorCode =
    | 'invalid_request'
    | 'invalid_client'
    | 'invalid_grant'
    | 'unauthorized_client'
    | 'unsupported_grant_type'
    | 'invalid_scope';

export type TokenResponse = {
    status: number;
    headers: Record<string, string>;
    body: Record<string, string | number>;
};

export function buildTokenSuccess(input: {
    accessToken: string;
    expiresIn: number;
    scope: readonly string[];
}): TokenResponse {
    if (input.expiresIn <= 0 || !Number.isInteger(input.expiresIn))
        throw new RangeError('expiresIn must be a positive integer');
    if (!input.scope || input.scope.length === 0)
        throw new RangeError('scope must be non-empty');
    const scopeStr = formatScope(input.scope);

    return {
        status: 200,
        headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
        },
        body: {
            access_token: input.accessToken,
            token_type: 'Bearer',
            expires_in: input.expiresIn,
            scope: scopeStr,
        },
    };
}

export function buildTokenError(
    error: TokenErrorCode,
    description?: string,
): TokenResponse {
    const regex = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;
    if (description === '') {
        throw new RangeError('description must be a non-empty string');
    }
    if (description && !regex.test(description)) {
        throw new RangeError(
            'description must be a string containing only characters in the range %x20-21 / %x23-5B / %x5D-7E',
        );
    }

    const headers = {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
        ...(error === 'invalid_client'
            ? { 'WWW-Authenticate': 'Basic realm="oauth-as"' }
            : {}),
    };
    const body = {
        error: error,
        ...(description ? { error_description: description } : {}),
    };
    const status = error === 'invalid_client' ? 401 : 400;

    return {
        status,
        headers,
        body,
    };
}
