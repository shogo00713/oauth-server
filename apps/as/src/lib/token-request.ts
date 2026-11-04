import { readParam } from './params.js';
import { isValidCodeVerifier } from './pkce.js';

type TokenRequest = {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    clientId?: string | undefined;
};

type TokenRequestResult =
    | { ok: true; value: TokenRequest }
    | { ok: false; error: 'invalid_request' | 'unsupported_grant_type' };

export function parseTokenRequest(body: unknown): TokenRequestResult {
    if (typeof body !== 'object' || !body)
        return { ok: false, error: 'invalid_request' };

    const PARAM_NAMES = [
        'grant_type',
        'code',
        'redirect_uri',
        'code_verifier',
        'client_id',
        'client_secret',
    ];

    const params = Object.fromEntries(
        PARAM_NAMES.map((name) => [name, readParam(body, name)]),
    );

    if (Object.values(params).includes(null)) {
        return { ok: false, error: 'invalid_request' };
    }

    const {
        grant_type,
        code,
        redirect_uri,
        code_verifier,
        client_id,
        client_secret,
    } = params;

    if (!grant_type) return { ok: false, error: 'invalid_request' };

    if (grant_type !== `authorization_code`)
        return { ok: false, error: 'unsupported_grant_type' };

    if (client_secret) return { ok: false, error: 'invalid_request' };

    if (!code || !redirect_uri) return { ok: false, error: 'invalid_request' };

    if (!code_verifier || !isValidCodeVerifier(code_verifier))
        return { ok: false, error: 'invalid_request' };

    if (client_id)
        return {
            ok: true,
            value: {
                code: code,
                redirectUri: redirect_uri,
                codeVerifier: code_verifier,
                clientId: client_id,
            },
        };
    else {
        return {
            ok: true,
            value: {
                code: code,
                redirectUri: redirect_uri,
                codeVerifier: code_verifier,
            },
        };
    }
}
