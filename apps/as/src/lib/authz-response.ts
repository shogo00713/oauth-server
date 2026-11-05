import { isValidRedirectUriFormat } from './redirect-uri.js';

export type AuthzErrorCode =
    | 'invalid_request'
    | 'unauthorized_client'
    | 'access_denied'
    | 'unsupported_response_type'
    | 'invalid_scope'
    | 'server_error'
    | 'temporarily_unavailable';

function appendParams(
    redirectUri: string,
    params: [string, string | undefined][],
): string {
    if (!isValidRedirectUriFormat(redirectUri)) {
        throw new RangeError('invalid redirect uri format');
    }
    const url = new URL(redirectUri);
    const filteredParams = params.filter(
        (param): param is [string, string] =>
            param[1] !== undefined && param[1] !== '',
    );
    if (filteredParams.some((param) => url.searchParams.has(param[0]))) {
        throw new RangeError('same parameters are added');
    }
    let separator: string;
    if (!redirectUri.includes('?')) {
        separator = '?';
    } else if (/[?&]$/.test(redirectUri)) {
        separator = '';
    } else {
        separator = '&';
    }
    return (
        redirectUri + separator + new URLSearchParams(filteredParams).toString()
    );
}

export function buildAuthzSuccessUrl(
    redirectUri: string,
    params: { code: string; state?: string | undefined },
): string {
    if (!params.code) throw new RangeError('no code');
    return appendParams(redirectUri, [
        ['code', params.code],
        ['state', params.state],
    ]);
}

export function buildAuthzErrorUrl(
    redirectUri: string,
    params: {
        error: AuthzErrorCode;
        description?: string | undefined;
        state?: string | undefined;
    },
): string {
    const regex = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

    if (
        (params.description && !regex.test(params.description)) ||
        params.description === ''
    )
        throw new RangeError('invalid description!');
    return appendParams(redirectUri, [
        ['error', params.error],
        ['error_description', params.description],
        ['state', params.state],
    ]);
}
