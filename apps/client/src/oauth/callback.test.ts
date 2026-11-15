import { describe, expect, it } from 'vitest';
import { parseCallback } from './callback.js';

const STATE = 'expected-state-value';
const STATE_MISMATCH = { kind: 'invalid', reason: 'state_mismatch' };
const MALFORMED = { kind: 'invalid', reason: 'malformed' };

// 正しい state が付いた、クエリ
const query = (extra: Record<string, unknown>) => ({ state: STATE, ...extra });

describe('CALLBACK /callback に戻ってきたクエリの検査 RFC 6749 4.1.2 / 4.1.2.1', () => {
    describe('parseCallback', () => {
        describe('認可コードが取れる(code)', () => {
            it('state が合っていて、code がある', () => {
                expect(parseCallback(query({ code: 'abc123' }), STATE)).toEqual(
                    {
                        kind: 'code',
                        code: 'abc123',
                    },
                );
            });

            it('知らないパラメータは、無視する(iss、session_state など)', () => {
                const result = parseCallback(
                    query({
                        code: 'abc123',
                        iss: 'http://localhost:4000',
                        session_state: 'x',
                        foo: ['a', 'b'],
                    }),
                    STATE,
                );

                expect(result).toEqual({ kind: 'code', code: 'abc123' });
            });

            it('error_uri が付いていても、無視する', () => {
                const result = parseCallback(
                    query({ code: 'abc', error_uri: 'http://x.example/e' }),
                    STATE,
                );

                expect(result).toEqual({ kind: 'code', code: 'abc' });
            });

            it.each([
                { name: 'base64url の文字', code: 'AZaz09-_' },
                { name: '記号(. ~ + / =)', code: 'a.b~c+d/e=' },
                { name: '空白や引用符(VSCHAR は %x20-7E)', code: 'a b"c' },
                { name: '前後の空白(加工しない)', code: ' abc ' },
                { name: '1 文字', code: 'a' },
                { name: '512 文字(上限)', code: 'a'.repeat(512) },
            ])('使える code: $name', ({ code }) => {
                expect(parseCallback(query({ code }), STATE)).toEqual({
                    kind: 'code',
                    code,
                });
            });

            it('プロトタイプの無いオブジェクトのクエリでも、読める', () => {
                const raw = Object.assign(Object.create(null), {
                    state: STATE,
                    code: 'abc',
                });

                expect(parseCallback(raw, STATE)).toEqual({
                    kind: 'code',
                    code: 'abc',
                });
            });

            it('渡したクエリを、書き換えない', () => {
                const raw = query({ code: 'abc', foo: 'bar' });
                const copy = { ...raw };

                parseCallback(raw, STATE);

                expect(raw).toEqual(copy);
            });
        });

        describe('state が合わない(state_mismatch): 何も信用しない', () => {
            it.each([
                { name: '違う値', raw: { state: 'other', code: 'abc' } },
                {
                    name: '大文字小文字が違う',
                    raw: { state: STATE.toUpperCase(), code: 'abc' },
                },
                {
                    name: '送った物の前方',
                    raw: { state: STATE.slice(0, -1), code: 'abc' },
                },
                {
                    name: '送った物に、文字が付いている',
                    raw: { state: `${STATE}x`, code: 'abc' },
                },
                {
                    name: '前後に空白',
                    raw: { state: ` ${STATE} `, code: 'abc' },
                },
                { name: 'state が無い', raw: { code: 'abc' } },
                { name: 'state が空文字', raw: { state: '', code: 'abc' } },
                {
                    name: 'state が繰り返されている(同じ値)',
                    raw: { state: [STATE, STATE], code: 'abc' },
                },
                {
                    name: 'state が 1 つだけの配列',
                    raw: { state: [STATE], code: 'abc' },
                },
                {
                    name: 'state が文字列ではない',
                    raw: { state: 12, code: 'abc' },
                },
                {
                    name: 'state がオブジェクト',
                    raw: { state: { a: STATE }, code: 'abc' },
                },
            ])('$name', ({ raw }) => {
                expect(parseCallback(raw, STATE)).toEqual(STATE_MISMATCH);
            });

            it.each([
                {
                    name: 'undefined(ログインを始めていない)',
                    expected: undefined,
                },
                { name: '空文字', expected: '' },
            ])(
                'セッションに state が無ければ、何が来ても、state_mismatch: $name',
                ({ expected }) => {
                    expect(
                        parseCallback(query({ code: 'abc' }), expected),
                    ).toEqual(STATE_MISMATCH);
                    expect(
                        parseCallback({ state: '', code: 'abc' }, expected),
                    ).toEqual(STATE_MISMATCH);
                },
            );

            it('state が違えば、エラーが付いていても、エラーとして扱わない(偽のエラーの表示を防ぐ)', () => {
                expect(
                    parseCallback(
                        { state: 'other', error: 'access_denied' },
                        STATE,
                    ),
                ).toEqual(STATE_MISMATCH);
            });

            it('state が違えば、code が壊れていても、state_mismatch(state が先)', () => {
                expect(
                    parseCallback({ state: 'other', code: ['a', 'b'] }, STATE),
                ).toEqual(STATE_MISMATCH);
            });

            it('継承されたプロパティの state は、無い物として扱う', () => {
                const raw = Object.create({ state: STATE, code: 'abc' });

                expect(parseCallback(raw, STATE)).toEqual(STATE_MISMATCH);
            });

            it.each([
                { name: 'undefined', raw: undefined },
                { name: 'null', raw: null },
                { name: '文字列', raw: `state=${STATE}&code=abc` },
                { name: '数値', raw: 12 },
                { name: '配列', raw: [STATE] },
            ])('クエリが、オブジェクトではない: $name', ({ raw }) => {
                expect(parseCallback(raw, STATE)).toEqual(STATE_MISMATCH);
            });
        });

        describe('AS からのエラー(error): RFC 6749 4.1.2.1', () => {
            it('error だけ', () => {
                expect(
                    parseCallback(query({ error: 'access_denied' }), STATE),
                ).toEqual({ kind: 'error', error: 'access_denied' });
            });

            it('error_description が付いていれば、それも返る', () => {
                const result = parseCallback(
                    query({
                        error: 'access_denied',
                        error_description:
                            'The resource owner denied the request',
                    }),
                    STATE,
                );

                expect(result).toEqual({
                    kind: 'error',
                    error: 'access_denied',
                    description: 'The resource owner denied the request',
                });
            });

            it.each([
                'invalid_request',
                'unauthorized_client',
                'access_denied',
                'unsupported_response_type',
                'invalid_scope',
                'server_error',
                'temporarily_unavailable',
            ])('RFC の error の値は、そのまま返る: %s', (error) => {
                expect(parseCallback(query({ error }), STATE)).toEqual({
                    kind: 'error',
                    error,
                });
            });

            it('知らない error の値でも、使える文字なら、そのまま返る(意味は、呼ぶ側が決める)', () => {
                expect(
                    parseCallback(query({ error: 'something_new' }), STATE),
                ).toEqual({ kind: 'error', error: 'something_new' });
            });

            it('code が空文字なら、無い物として扱って、エラーとして返る', () => {
                expect(
                    parseCallback(
                        query({ error: 'access_denied', code: '' }),
                        STATE,
                    ),
                ).toEqual({ kind: 'error', error: 'access_denied' });
            });

            it.each([
                { name: '空文字', value: '' },
                { name: '日本語', value: '拒否された' },
                { name: 'ダブルクォートを含む', value: 'say "no"' },
                { name: 'バックスラッシュを含む', value: 'a\\b' },
                { name: '改行を含む', value: 'line1\nline2' },
                { name: '制御文字を含む', value: 'a\u0007b' },
                { name: '繰り返されている', value: ['a', 'b'] },
                { name: '文字列ではない', value: 12 },
            ])(
                'error_description が使えない形($name)なら、捨てる(error は、そのまま返る)',
                ({ value }) => {
                    expect(
                        parseCallback(
                            query({
                                error: 'access_denied',
                                error_description: value,
                            }),
                            STATE,
                        ),
                    ).toEqual({ kind: 'error', error: 'access_denied' });
                },
            );

            it.each([
                { name: '日本語', value: '拒否' },
                { name: 'ダブルクォートを含む', value: 'a"b' },
                { name: 'バックスラッシュを含む', value: 'a\\b' },
                { name: '改行を含む', value: 'a\nb' },
                {
                    name: '繰り返されている',
                    value: ['access_denied', 'access_denied'],
                },
                { name: '文字列ではない', value: 12 },
            ])('error が使えない形($name)なら、malformed', ({ value }) => {
                expect(parseCallback(query({ error: value }), STATE)).toEqual(
                    MALFORMED,
                );
            });

            it('error と code が、両方来たら、malformed(どちらも、信用しない)', () => {
                expect(
                    parseCallback(
                        query({ error: 'access_denied', code: 'abc' }),
                        STATE,
                    ),
                ).toEqual(MALFORMED);
            });
        });

        describe('code が使えない形: malformed', () => {
            it.each([
                { name: 'code も error も無い', raw: query({}) },
                { name: 'code が空文字', raw: query({ code: '' }) },
                {
                    name: 'code が繰り返されている',
                    raw: query({ code: ['a', 'b'] }),
                },
                { name: 'code が 1 つだけの配列', raw: query({ code: ['a'] }) },
                { name: 'code が文字列ではない', raw: query({ code: 12 }) },
                {
                    name: 'code が、513 文字(上限の 1 つ上)',
                    raw: query({ code: 'a'.repeat(513) }),
                },
                { name: 'code に日本語', raw: query({ code: '認可コード' }) },
                { name: 'code に改行', raw: query({ code: 'ab\ncd' }) },
                { name: 'code に制御文字', raw: query({ code: 'ab\u0000cd' }) },
                {
                    name: 'code に DEL(0x7F)',
                    raw: query({ code: 'ab\u007Fcd' }),
                },
            ])('$name', ({ raw }) => {
                expect(parseCallback(raw, STATE)).toEqual(MALFORMED);
            });
        });
    });
});
