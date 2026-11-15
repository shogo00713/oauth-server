/**
 * 認可リクエストの URL を組み立てる
 *   RFC 6749 4.1.1: response_type=code、client_id、redirect_uri、scope、state
 *   RFC 7636 4.3: code_challenge、code_challenge_method=S256
 *   RFC 6749 3.1: 認可エンドポイントに、元からあるクエリは、残す。フラグメントは、付けられない
 *   文字列を繋げるのではなく、URL として組む
 */
export type AuthorizeUrlInput = {
    authorizationEndpoint: string; // 認可エンドポイントの URL
    clientId: string;
    redirectUri: string;
    scope: string; // 空白で区切ったスコープ
    state: string;
    codeChallenge: string;
};

const regex = /^[A-Za-z0-9_-]{43}$/;

// http か https の、絶対 URL で、フラグメントが無いこと
function parseHttpUrl(value: string, name: string): URL {
    if (value.includes('#'))
        throw new RangeError(`${name} に、フラグメント(#)は付けられません`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new RangeError(`${name} は、絶対 URL にしてください`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        throw new RangeError(`${name} は、http か https の URL にしてください`);
    return url;
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
    const endpoint = parseHttpUrl(
        input.authorizationEndpoint,
        'authorizationEndpoint',
    );
    parseHttpUrl(input.redirectUri, 'redirectUri');
    if (!regex.test(input.codeChallenge))
        throw new RangeError('codeChallenge must express with base64URL');
    if (!input.clientId) throw new RangeError('invalid clientID');
    if (!input.scope) throw new RangeError('invalid scope');
    if (!input.state) throw new RangeError('invalid state');

    const params = endpoint.searchParams;
    params.set('response_type', 'code');
    params.set('client_id', input.clientId);
    params.set('redirect_uri', input.redirectUri);
    params.set('scope', input.scope);
    params.set('state', input.state);
    params.set('code_challenge', input.codeChallenge);
    params.set('code_challenge_method', 'S256');

    return endpoint.toString();
}
