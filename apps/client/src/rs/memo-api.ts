/**
 * RS(シンプルメモアプリ)の API を呼ぶ
 *   Authorization: Bearer <アクセストークン> を付ける(RFC 6750 2.1)
 *   返事を、画面の動きに直す(docs/design/client.md の表)
 *     200、201、204 → 画面に反映 / 401 → 再ログイン / 403(insufficient_scope)→ 権限不足 /
 *     403(それ以外)→ 許可されていない / 404、5xx、通信の失敗 → エラー画面(リトライしない)
 */
export type Memo = {
    id: string;
    body: string;
    createdAt: string;
    updatedAt: string;
};

export type ApiFailure =
    // 401: トークンが使えない(期限切れなど)。セッションを捨てて、再ログイン
    | 'unauthorized'
    // 403 で、スコープが足りない
    | 'insufficient_scope'
    // 403 で、それ以外(他人のメモなど)
    | 'forbidden'
    | 'not_found'
    // 400 など: 送った内容が、正しくない。message に、RS の説明が入ることがある
    | 'invalid_request'
    // 5xx、通信の失敗、時間切れ、返事が読めない、想定してない返事
    | 'unavailable';

export type ApiResult<T> =
    | { ok: true; data: T }
    | { ok: false; failure: ApiFailure; message?: string | undefined };

export type MemoApi = {
    list(accessToken: string): Promise<ApiResult<Memo[]>>;
    get(accessToken: string, id: string): Promise<ApiResult<Memo>>;
    create(accessToken: string, body: string): Promise<ApiResult<Memo>>;
    update(
        accessToken: string,
        id: string,
        body: string,
    ): Promise<ApiResult<Memo>>;
    delete(accessToken: string, id: string): Promise<ApiResult<undefined>>;
};

export type MemoApiOptions = {
    // RS の URL(例: http://localhost:4002)。パスが付いていても良い(その下の /memos を呼ぶ)
    baseUrl: string;
    // 返事を待つ時間(ミリ秒)。省略したら 10 秒
    timeoutMs?: number | undefined;
};

const DEFAULT_TIMEOUT_MS = 10_000;
// error_description に使える文字(RFC 6749 5.2 と同じ)
const TEXT_CHARS = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;
// 使える id の形(英数字と _ -、128 文字まで。UUID も通る)
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function toMemo(value: unknown): Memo | undefined {
    if (!isRecord(value)) return undefined;
    const { id, body, createdAt, updatedAt } = value;
    if (
        typeof id !== 'string' ||
        typeof body !== 'string' ||
        typeof createdAt !== 'string' ||
        typeof updatedAt !== 'string'
    )
        return undefined;
    return { id, body, createdAt, updatedAt };
}

function toMemoList(value: unknown): Memo[] | undefined {
    if (!isRecord(value) || !Array.isArray(value['memos'])) return undefined;
    const memos = value['memos'].map(toMemo);
    return memos.every((memo) => memo !== undefined)
        ? (memos as Memo[])
        : undefined;
}

const failure = (
    failure: ApiFailure,
    message?: string,
): { ok: false; failure: ApiFailure; message?: string | undefined } => ({
    ok: false,
    failure,
    ...(message === undefined ? {} : { message }),
});

export function createMemoApi(options: MemoApiOptions): MemoApi {
    let base: URL;
    try {
        base = new URL(options.baseUrl);
    } catch {
        throw new RangeError('baseUrl は、絶対 URL にしてください');
    }
    if (base.protocol !== 'http:' && base.protocol !== 'https:')
        throw new RangeError('baseUrl は、http か https の URL にしてください');
    // パスが付いていても、その下に memos を置く(末尾に / を足してから、相対で繋ぐ)
    const root = `${base.origin}${base.pathname.replace(/\/+$/, '')}/`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const urlOf = (...segments: string[]) =>
        new URL(['memos', ...segments.map(encodeURIComponent)].join('/'), root);

    async function call<T>(
        accessToken: string,
        method: string,
        url: URL,
        body: string | undefined,
        parse: (json: unknown) => T | undefined,
    ): Promise<ApiResult<T>> {
        let response: Response;
        let text: string;
        try {
            response = await fetch(url, {
                method,
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: 'application/json',
                    ...(body === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                },
                ...(body === undefined ? {} : { body }),
                redirect: 'error',
                signal: AbortSignal.timeout(timeoutMs),
            });
            text = await response.text();
        } catch {
            return failure('unavailable');
        }

        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            json = undefined;
        }

        const { status } = response;
        if (status >= 200 && status < 300) {
            const data = parse(json);
            return data === undefined
                ? failure('unavailable')
                : { ok: true, data };
        }
        if (status === 401) return failure('unauthorized');
        if (status === 403) {
            const challenge = response.headers.get('www-authenticate') ?? '';
            const insufficient =
                /(^|[\s,])error="insufficient_scope"/.test(challenge) ||
                (isRecord(json) && json['error'] === 'insufficient_scope');
            return failure(insufficient ? 'insufficient_scope' : 'forbidden');
        }
        if (status === 404) return failure('not_found');
        if (status === 400 || status === 413 || status === 415) {
            const description = isRecord(json)
                ? json['error_description']
                : undefined;
            return failure(
                'invalid_request',
                typeof description === 'string' && TEXT_CHARS.test(description)
                    ? description
                    : undefined,
            );
        }
        return failure('unavailable');
    }

    const json = (value: unknown) => JSON.stringify(value);

    // 画面の URL の値(id)を、そのまま RS の道に使わない。使える形でなければ、RS を呼ばずに not_found
    // (「..」や「/」が入ると、別の道を呼べてしまう)
    const withId = <T>(
        id: string,
        run: () => Promise<ApiResult<T>>,
    ): Promise<ApiResult<T>> =>
        SAFE_ID.test(id) ? run() : Promise.resolve(failure('not_found'));

    return {
        list: (token) => call(token, 'GET', urlOf(), undefined, toMemoList),
        get: (token, id) =>
            withId(id, () => call(token, 'GET', urlOf(id), undefined, toMemo)),
        create: (token, body) =>
            call(token, 'POST', urlOf(), json({ body }), toMemo),
        update: (token, id, body) =>
            withId(id, () =>
                call(token, 'PUT', urlOf(id), json({ body }), toMemo),
            ),
        // 204 は、本文が無い。成功した、という印として、data は undefined にする
        delete: (token, id) =>
            withId(id, async () => {
                const result = await call<true>(
                    token,
                    'DELETE',
                    urlOf(id),
                    undefined,
                    () => true,
                );
                return result.ok ? { ok: true, data: undefined } : result;
            }),
    };
}
