/**
 * 認可コードを、アクセストークンに引き換える(AS の /token を呼ぶ)
 *   RFC 6749 4.1.3: grant_type=authorization_code、code、redirect_uri、(PKCE の)code_verifier
 *   RFC 6749 2.3.1: confidential client は、HTTP Basic で認証する。id と secret は、先に form 形式でエンコードする
 *   RFC 6749 5.1 / 5.2: 成功の返事と、エラーの返事の読み方
 */
export type TokenExchangeInput = {
    // AS のトークンエンドポイントの URL(例: http://localhost:4000/token)
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    code: string;
    // 認可リクエストで送った物と、同じ値
    redirectUri: string;
    // 認可リクエストの code_challenge の元になった code_verifier
    codeVerifier: string;
};

export type TokenSet = {
    accessToken: string;
    // 期限(秒。1970 年からの秒数)。AS が expires_in を返さなければ undefined
    expiresAt: number | undefined;
    // AS が返したスコープ(空白区切りの文字列)。返さなければ undefined(要求した物と同じ、という意味)
    scope: string | undefined;
};

export type TokenExchangeResult =
    | { ok: true; tokens: TokenSet }
    // AS が、OAuth のエラーで断った(invalid_grant など)
    | {
          ok: false;
          reason: 'rejected';
          error: string;
          description?: string | undefined;
      }
    // それ以外の失敗(通信できない、時間切れ、返事が読めない、など)。message は、ログ用(秘密は入らない)
    | { ok: false; reason: 'failed'; message: string };

export type TokenExchangeOptions = {
    // 今の時刻(秒)を返す関数。テスト用。省略したら、本物の時計
    now?: (() => number) | undefined;
    // 返事を待つ時間(ミリ秒)。省略したら 10 秒
    timeoutMs?: number | undefined;
};
const DEFAULT_TIMEOUT_MS = 10_000;
// アクセストークンに使える文字(RFC 6750 2.1 の b64token)
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/;
// スコープの形(空白 1 個区切り。RFC 6749 3.3)
const SCOPE = /^[\x21\x23-\x5B\x5D-\x7E]+( [\x21\x23-\x5B\x5D-\x7E]+)*$/;
// error と error_description に使える文字(RFC 6749 5.2)
const ERROR_CHARS = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

// application/x-www-form-urlencoded の形に、エンコードする(空白は +、その他の記号は %XX)
const formEncode = (value: string): string =>
    new URLSearchParams({ v: value }).toString().slice('v='.length);

const failed = (message: string): TokenExchangeResult => ({
    ok: false,
    reason: 'failed',
    message,
});

export async function exchangeCode(
    input: TokenExchangeInput,
    options: TokenExchangeOptions = {},
): Promise<TokenExchangeResult> {
    const now = options.now ?? (() => Math.floor(Date.now() / 1000));

    const credentials = Buffer.from(
        `${formEncode(input.clientId)}:${formEncode(input.clientSecret)}`,
    ).toString('base64');

    let response: Response;
    let text: string;
    try {
        response = await fetch(input.tokenEndpoint, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${credentials}`,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code: input.code,
                redirect_uri: input.redirectUri,
                code_verifier: input.codeVerifier,
            }),
            // 転送は、辿らない(Authorization を、別の所へ送らない)
            redirect: 'error',
            signal: AbortSignal.timeout(
                options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ),
        });
        text = await response.text();
    } catch {
        return failed('token endpoint: 通信に失敗しました(または時間切れ)');
    }

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        json = undefined;
    }
    const body =
        typeof json === 'object' && json !== null && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : undefined;

    if (response.status === 200) {
        if (!body)
            return failed(
                'token endpoint: 返事が JSON のオブジェクトではありません',
            );

        const { access_token, token_type, expires_in, scope } = body;
        if (typeof access_token !== 'string' || !B64TOKEN.test(access_token))
            return failed('token endpoint: access_token が使えない形です');
        if (
            typeof token_type !== 'string' ||
            token_type.toLowerCase() !== 'bearer'
        )
            return failed(
                'token endpoint: token_type が Bearer ではありません',
            );
        if (
            expires_in !== undefined &&
            (typeof expires_in !== 'number' ||
                !Number.isInteger(expires_in) ||
                expires_in <= 0)
        )
            return failed('token endpoint: expires_in が使えない形です');
        if (
            scope !== undefined &&
            (typeof scope !== 'string' || !SCOPE.test(scope))
        )
            return failed('token endpoint: scope が使えない形です');

        return {
            ok: true,
            tokens: {
                accessToken: access_token,
                expiresAt:
                    expires_in === undefined ? undefined : now() + expires_in,
                scope,
            },
        };
    }

    if (response.status === 400 || response.status === 401) {
        const { error, error_description } = body ?? {};
        if (typeof error === 'string' && ERROR_CHARS.test(error))
            return {
                ok: false,
                reason: 'rejected',
                error,
                ...(typeof error_description === 'string' &&
                ERROR_CHARS.test(error_description)
                    ? { description: error_description }
                    : {}),
            };
    }

    return failed(
        `token endpoint: 想定していない返事です(HTTP ${response.status})`,
    );
}
