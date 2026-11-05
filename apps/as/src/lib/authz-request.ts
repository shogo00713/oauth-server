import type { Client } from '../stores/client-store.js';
import { readParam } from './params.js';
import { isValidCodeChallenge } from './pkce.js';
import { haveSameRedirectUri } from './redirect-uri.js';
import { isSubsetScope, parseScope } from './scope.js';

export type AuthzRequest = {
    clientId: string;
    redirectUri: string;
    scope: string[];
    state: string | undefined;
    codeChallenge: string;
};

export type AuthzRequestError =
    'invalid_request' | 'unsupported_response_type' | 'invalid_scope';

export type AuthzRequestResult =
    | { ok: true; value: AuthzRequest }
    | {
          ok: false;
          kind: 'page';
          reason: 'invalid_client_id' | 'invalid_redirect_uri';
      }
    | {
          ok: false;
          kind: 'redirect';
          redirectUri: string;
          error: AuthzRequestError;
          description: string;
          state: string | undefined;
      };

export type AuthzRequestOptions = {
    supportedScopes: readonly string[];
    defaultScope: readonly string[];
};

const redirect = (
    redirectUri: string,
    error: AuthzRequestError,
    description: string,
    state: string | undefined,
): AuthzRequestResult => {
    return {
        ok: false,
        kind: 'redirect',
        redirectUri: redirectUri,
        error: error,
        description: description,
        state: state,
    };
};

export function parseAuthzRequest(
    query: unknown,
    client: Client | null,
    options: AuthzRequestOptions,
): AuthzRequestResult {
    const paramClientId = readParam(query, 'client_id');

    if (!client || !paramClientId || paramClientId !== client.clientId) {
        return { ok: false, kind: 'page', reason: 'invalid_client_id' };
    }

    const paramRedirectUri = readParam(query, 'redirect_uri');

    if (
        !paramRedirectUri ||
        !haveSameRedirectUri(paramRedirectUri, client.redirectUris)
    ) {
        return { ok: false, kind: 'page', reason: 'invalid_redirect_uri' };
    }

    const paramState = readParam(query, 'state');
    const regex = /^[\x20-\x7E]+$/;
    if (
        paramState === null ||
        (paramState !== undefined && !regex.test(paramState))
    ) {
        return redirect(
            paramRedirectUri,
            'invalid_request',
            'invalid shape of state',
            undefined,
        );
    }

    const paramResponseType = readParam(query, 'response_type');
    const paramScope = readParam(query, 'scope');
    const paramCode_challenge = readParam(query, 'code_challenge');
    const paramCode_challenge_method = readParam(
        query,
        'code_challenge_method',
    );
    if (
        paramResponseType === null ||
        paramScope === null ||
        paramCode_challenge === null ||
        paramCode_challenge_method === null
    ) {
        return redirect(
            paramRedirectUri,
            'invalid_request',
            'invalid parameter',
            paramState,
        );
    }

    if (!paramResponseType) {
        return redirect(
            paramRedirectUri,
            'invalid_request',
            'use auth code grant!',
            paramState,
        );
    }
    if (paramResponseType !== 'code') {
        return redirect(
            paramRedirectUri,
            'unsupported_response_type',
            'use auth code grant!',
            paramState,
        );
    }

    if (!paramCode_challenge || !isValidCodeChallenge(paramCode_challenge)) {
        return redirect(
            paramRedirectUri,
            'invalid_request',
            'invalid shape of code_challenge',
            paramState,
        );
    }

    if (paramCode_challenge_method !== 'S256') {
        return redirect(
            paramRedirectUri,
            'invalid_request',
            'use S256 for code_challenge method',
            paramState,
        );
    }

    let reqscope: string[] = [...options.defaultScope];
    if (paramScope) {
        const temptscope = parseScope(paramScope);
        if (!temptscope) {
            return redirect(
                paramRedirectUri,
                'invalid_scope',
                'invalid scope shape!',
                paramState,
            );
        }
        if (!isSubsetScope(temptscope, options.supportedScopes)) {
            return redirect(
                paramRedirectUri,
                'invalid_scope',
                'seeking unsupported scope!',
                paramState,
            );
        }
        reqscope = temptscope;
    }

    return {
        ok: true,
        value: {
            clientId: paramClientId,
            redirectUri: paramRedirectUri,
            scope: reqscope,
            state: paramState,
            codeChallenge: paramCode_challenge,
        },
    };
}
