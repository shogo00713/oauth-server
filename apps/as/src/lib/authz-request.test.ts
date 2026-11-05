import { describe, expect, it } from 'vitest';
import type { Client } from '../stores/client-store.js';
import { parseAuthzRequest, type AuthzRequestResult } from './authz-request.js';

const REDIRECT_URI = 'http://localhost:4001/callback';
const REDIRECT_URI_WITH_QUERY = 'https://memoboard.example.com/cb?x=1';
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const CLIENT: Client = {
    clientId: 'memoboard',
    secretHash: 'a'.repeat(64),
    name: 'メモボード',
    redirectUris: [REDIRECT_URI, REDIRECT_URI_WITH_QUERY],
};

const OPTIONS = {
    supportedScopes: ['read', 'write'],
    defaultScope: ['read'],
};

// RFC 6749 4.1.2.1 / 付録 A.8: error_description に使える文字(1 文字以上)
const DESCRIPTION_PATTERN = /^[\x20\x21\x23-\x5B\x5D-\x7E]+$/;

const validQuery = (): Record<string, unknown> => ({
    response_type: 'code',
    client_id: 'memoboard',
    redirect_uri: REDIRECT_URI,
    scope: 'read write',
    state: 'xyz',
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: 'S256',
});

const without = (name: string): Record<string, unknown> => {
    const query = validQuery();
    delete query[name];
    return query;
};

const withParams = (
    overrides: Record<string, unknown>,
): Record<string, unknown> => ({ ...validQuery(), ...overrides });

const parse = (query: unknown, client: Client | null = CLIENT) =>
    parseAuthzRequest(query, client, OPTIONS);

// 戻してはいけない失敗(エラー画面を出す)
const expectPage = (
    result: AuthzRequestResult,
    reason: 'invalid_client_id' | 'invalid_redirect_uri',
) => {
    expect(result).toEqual({ ok: false, kind: 'page', reason });
};

// 戻していい失敗(redirect_uri に、error つきで戻す)
const checkRedirect = (
    result: AuthzRequestResult,
    error: string,
    state: string | undefined,
) => {
    if (result.ok || result.kind !== 'redirect')
        throw new Error(`redirect のはずが、${JSON.stringify(result)}`);

    expect(result.error).toBe(error);
    expect(result.redirectUri).toBe(REDIRECT_URI);
    expect(result.state).toBe(state);
    expect(result.description).toMatch(DESCRIPTION_PATTERN);
};

// state を省略したら、'xyz' が返る(validQuery の state)
const expectRedirect = (
    result: AuthzRequestResult,
    error: string,
    state: string = 'xyz',
) => checkRedirect(result, error, state);

// state が、返らない(undefined)
const expectRedirectWithoutState = (
    result: AuthzRequestResult,
    error: string,
) => checkRedirect(result, error, undefined);

describe('AUTHZ REQUEST RFC 6749 4.1.1 / 4.1.2.1 / RFC 7636 4.3', () => {
    describe('parseAuthzRequest', () => {
        describe('成功', () => {
            it('全部そろっていれば、ok と、値が返る', () => {
                expect(parse(validQuery())).toEqual({
                    ok: true,
                    value: {
                        clientId: 'memoboard',
                        redirectUri: REDIRECT_URI,
                        scope: ['read', 'write'],
                        state: 'xyz',
                        codeChallenge: CODE_CHALLENGE,
                    },
                });
            });

            it('登録されている 2 つ目の redirect_uri(クエリ付き)でも、通る', () => {
                const result = parse(
                    withParams({ redirect_uri: REDIRECT_URI_WITH_QUERY }),
                );

                expect(result).toMatchObject({
                    ok: true,
                    value: { redirectUri: REDIRECT_URI_WITH_QUERY },
                });
            });

            it('state が無ければ、state は undefined', () => {
                const result = parse(without('state'));

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.value.state).toBeUndefined();
            });

            it('state が空文字なら、無い扱い', () => {
                const result = parse(withParams({ state: '' }));

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.value.state).toBeUndefined();
            });

            it('state に、空白や記号があっても、そのまま返る', () => {
                const result = parse(withParams({ state: 'a b&c=d?/%' }));

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.value.state).toBe('a b&c=d?/%');
            });

            it('scope が無ければ、既定のスコープになる', () => {
                const result = parse(without('scope'));

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.value.scope).toEqual(['read']);
            });

            it('scope が空文字なら、無い扱い(既定のスコープ)', () => {
                const result = parse(withParams({ scope: '' }));

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.value.scope).toEqual(['read']);
            });

            it('既定のスコープは、渡した配列とは別物(書き換えても、次に影響しない)', () => {
                const options = {
                    supportedScopes: ['read', 'write'],
                    defaultScope: ['read'],
                };
                const first = parseAuthzRequest(
                    without('scope'),
                    CLIENT,
                    options,
                );
                if (!first.ok) throw new Error('ok のはず');

                first.value.scope.push('write');

                expect(options.defaultScope).toEqual(['read']);
            });

            it('scope は、並べ直されて、重複が取れる', () => {
                const result = parse(withParams({ scope: 'write read read' }));

                expect(result.ok).toBe(true);
                if (result.ok)
                    expect(result.value.scope).toEqual(['read', 'write']);
            });

            it('scope は、1 つだけでもいい', () => {
                const result = parse(withParams({ scope: 'write' }));

                expect(result.ok).toBe(true);
                if (result.ok) expect(result.value.scope).toEqual(['write']);
            });

            it('知らないパラメータは、無視する', () => {
                expect(parse(withParams({ foo: 'bar' })).ok).toBe(true);
            });
        });

        describe('client_id が不正(戻さない: page)', () => {
            it.each([
                { name: 'undefined', query: undefined },
                { name: 'null', query: null },
                { name: '文字列', query: 'client_id=memoboard' },
                { name: '配列', query: ['memoboard'] },
            ])('query がオブジェクトじゃない: $name', ({ query }) => {
                expectPage(parse(query), 'invalid_client_id');
            });

            it.each([
                { name: '無い', query: without('client_id') },
                { name: '空文字', query: withParams({ client_id: '' }) },
                {
                    name: '2 回ある',
                    query: withParams({
                        client_id: ['memoboard', 'memoboard'],
                    }),
                },
            ])('client_id が $name', ({ query }) => {
                expectPage(parse(query), 'invalid_client_id');
            });

            it('登録されてないクライアント(client が null)', () => {
                expectPage(parse(validQuery(), null), 'invalid_client_id');
            });

            it('渡された client の ID と、query の client_id が違う', () => {
                expectPage(
                    parse(withParams({ client_id: 'other-app' })),
                    'invalid_client_id',
                );
            });

            it('client_id が不正なら、他のパラメータが全部壊れていても、page(戻さない)', () => {
                const query = {
                    client_id: 'unknown',
                    redirect_uri: 'https://evil.example.com/cb',
                    response_type: 'token',
                };

                expectPage(parse(query, null), 'invalid_client_id');
            });
        });

        describe('redirect_uri が不正(戻さない: page)', () => {
            it.each([
                { name: '無い', query: without('redirect_uri') },
                { name: '空文字', query: withParams({ redirect_uri: '' }) },
                {
                    name: '2 回ある',
                    query: withParams({
                        redirect_uri: [REDIRECT_URI, REDIRECT_URI],
                    }),
                },
            ])('redirect_uri が $name', ({ query }) => {
                expectPage(parse(query), 'invalid_redirect_uri');
            });

            it.each([
                {
                    name: '全然違う URL',
                    value: 'https://evil.example.com/callback',
                },
                { name: '末尾に / が付く', value: `${REDIRECT_URI}/` },
                {
                    name: '大文字小文字が違う',
                    value: 'HTTP://LOCALHOST:4001/callback',
                },
                {
                    name: 'ポートが違う',
                    value: 'http://localhost:4002/callback',
                },
                { name: 'パスが違う', value: 'http://localhost:4001/other' },
                {
                    name: '登録に無いクエリが付く',
                    value: `${REDIRECT_URI}?a=1`,
                },
                { name: 'フラグメントが付く', value: `${REDIRECT_URI}#frag` },
                {
                    name: '登録 URL の後ろに、別のホストを足す',
                    value: `${REDIRECT_URI}.evil.example.com`,
                },
                {
                    name: '登録済みの URL を、空白でつなぐ',
                    value: `${REDIRECT_URI} ${REDIRECT_URI_WITH_QUERY}`,
                },
            ])('登録と完全一致しない: $name', ({ value }) => {
                expectPage(
                    parse(withParams({ redirect_uri: value })),
                    'invalid_redirect_uri',
                );
            });

            it('redirect_uri が不正なら、他のパラメータが壊れていても、page(戻さない)', () => {
                const query = withParams({
                    redirect_uri: 'https://evil.example.com/cb',
                    response_type: 'token',
                    state: ['a', 'b'],
                });

                expectPage(parse(query), 'invalid_redirect_uri');
            });
        });

        describe('それ以外が不正(戻す: redirect)', () => {
            it.each([
                {
                    name: 'response_type が無い',
                    query: without('response_type'),
                    error: 'invalid_request',
                },
                {
                    name: 'response_type が空文字',
                    query: withParams({ response_type: '' }),
                    error: 'invalid_request',
                },
                {
                    name: 'response_type が token',
                    query: withParams({ response_type: 'token' }),
                    error: 'unsupported_response_type',
                },
                {
                    name: 'response_type が大文字(CODE)',
                    query: withParams({ response_type: 'CODE' }),
                    error: 'unsupported_response_type',
                },
                {
                    name: 'response_type が code token',
                    query: withParams({ response_type: 'code token' }),
                    error: 'unsupported_response_type',
                },
                {
                    name: 'code_challenge が無い(PKCE が必須)',
                    query: without('code_challenge'),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge が空文字',
                    query: withParams({ code_challenge: '' }),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge が短い',
                    query: withParams({ code_challenge: 'abc' }),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge が 44 文字(S256 は 43 文字)',
                    query: withParams({ code_challenge: 'A'.repeat(44) }),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge に使えない文字(+)がある',
                    query: withParams({ code_challenge: 'A'.repeat(42) + '+' }),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge_method が無い(省略は plain 扱いになるので、弾く)',
                    query: without('code_challenge_method'),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge_method が空文字',
                    query: withParams({ code_challenge_method: '' }),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge_method が plain',
                    query: withParams({ code_challenge_method: 'plain' }),
                    error: 'invalid_request',
                },
                {
                    name: 'code_challenge_method が小文字(s256)',
                    query: withParams({ code_challenge_method: 's256' }),
                    error: 'invalid_request',
                },
                {
                    name: 'scope の形が不正(空白が 2 つ)',
                    query: withParams({ scope: 'read  write' }),
                    error: 'invalid_scope',
                },
                {
                    name: 'scope の先頭に空白',
                    query: withParams({ scope: ' read' }),
                    error: 'invalid_scope',
                },
                {
                    name: '知らない scope',
                    query: withParams({ scope: 'admin' }),
                    error: 'invalid_scope',
                },
                {
                    name: '一部だけ知らない scope',
                    query: withParams({ scope: 'read admin' }),
                    error: 'invalid_scope',
                },
                {
                    name: 'scope が大文字(READ)',
                    query: withParams({ scope: 'READ' }),
                    error: 'invalid_scope',
                },
            ])('$name', ({ query, error }) => {
                expectRedirect(parse(query), error);
            });

            it.each([
                'response_type',
                'scope',
                'code_challenge',
                'code_challenge_method',
            ])(
                '同じパラメータが 2 回ある: %s(state は、そのまま返る)',
                (name) => {
                    const result = parse(withParams({ [name]: ['a', 'b'] }));

                    expectRedirect(result, 'invalid_request');
                },
            );
        });

        describe('state', () => {
            it('state が 2 回ある(state は、返せない)', () => {
                const result = parse(withParams({ state: ['a', 'b'] }));

                expectRedirectWithoutState(result, 'invalid_request');
            });

            it.each([
                { name: '日本語', value: 'あ' },
                { name: 'タブ', value: 'a\tb' },
                { name: '改行', value: 'a\nb' },
                { name: 'DEL(0x7F)', value: 'a\x7Fb' },
            ])(
                '使えない文字(RFC 6749 付録 A.5 は 0x20〜0x7E): $name',
                ({ value }) => {
                    const result = parse(withParams({ state: value }));

                    expectRedirectWithoutState(result, 'invalid_request');
                },
            );

            it('エラーの時も、state が、そのまま返る', () => {
                const result = parse(
                    withParams({ response_type: 'token', state: 'a b&c=d' }),
                );

                expectRedirect(result, 'unsupported_response_type', 'a b&c=d');
            });

            it('エラーの時に、state が空文字なら、無い扱い', () => {
                const result = parse(
                    withParams({ response_type: 'token', state: '' }),
                );

                expectRedirectWithoutState(result, 'unsupported_response_type');
            });

            it('エラーの時に、state が無ければ、undefined', () => {
                const result = parse({
                    ...without('state'),
                    response_type: 'token',
                });

                expectRedirectWithoutState(result, 'unsupported_response_type');
            });
        });

        describe('エラーの優先順位', () => {
            it('同じパラメータの繰り返しが、response_type の判定より先', () => {
                const result = parse(
                    withParams({ response_type: 'token', scope: ['a', 'b'] }),
                );

                expectRedirect(result, 'invalid_request');
            });

            it('response_type の判定が、PKCE の判定より先', () => {
                const result = parse({
                    ...without('code_challenge'),
                    response_type: 'token',
                });

                expectRedirect(result, 'unsupported_response_type');
            });

            it('PKCE の判定が、scope の判定より先', () => {
                const result = parse(
                    withParams({ code_challenge: 'abc', scope: 'admin' }),
                );

                expectRedirect(result, 'invalid_request');
            });

            it('code_challenge の判定が、code_challenge_method の判定より先', () => {
                const result = parse(
                    withParams({
                        code_challenge: 'abc',
                        code_challenge_method: 'plain',
                    }),
                );

                expectRedirect(result, 'invalid_request');
            });

            it('code_challenge_method が無くても、response_type の判定が先', () => {
                const result = parse({
                    ...without('code_challenge_method'),
                    response_type: 'token',
                });

                expectRedirect(result, 'unsupported_response_type');
            });
        });
    });
});
