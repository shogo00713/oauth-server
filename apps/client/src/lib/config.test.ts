import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const SECRET = 'c'.repeat(32);
const SESSION_SECRET = 's'.repeat(32);

const validEnv = (): Record<string, string | undefined> => ({
    BASE_URL: 'http://localhost:4001',
    PORT: '4001',
    AS_BASE_URL: 'http://localhost:4000',
    RS_BASE_URL: 'http://localhost:4002',
    CLIENT_SECRET: SECRET,
    SESSION_SECRET,
});

const DEFAULT_CONFIG = {
    baseUrl: 'http://localhost:4001',
    port: 4001,
    asBaseUrl: 'http://localhost:4000',
    rsBaseUrl: 'http://localhost:4002',
    clientId: 'memoboard',
    clientSecret: SECRET,
    sessionSecret: SESSION_SECRET,
    requestedScope: 'read write',
    redirectUri: 'http://localhost:4001/callback',
    authorizationEndpoint: 'http://localhost:4000/authorize',
    tokenEndpoint: 'http://localhost:4000/token',
};

const REQUIRED = [
    'BASE_URL',
    'PORT',
    'AS_BASE_URL',
    'RS_BASE_URL',
    'CLIENT_SECRET',
    'SESSION_SECRET',
];

const messageOf = (fn: () => unknown): string => {
    try {
        fn();
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return '';
};

// 投げられること、そして、悪い環境変数の名前が、メッセージに入っていること
const expectInvalid = (
    env: Record<string, string | undefined>,
    name: string,
) => {
    expect(() => loadConfig(env)).toThrow();
    expect(messageOf(() => loadConfig(env))).toContain(name);
};

describe('CONFIG client の環境変数の読み込み', () => {
    describe('loadConfig', () => {
        describe('読み込める例', () => {
            it('必須の 6 つだけで、残りは既定値になる。URL は、そこから作る', () => {
                expect(loadConfig(validEnv())).toEqual(DEFAULT_CONFIG);
            });

            it('全部指定すれば、その値になる', () => {
                const config = loadConfig({
                    BASE_URL: 'https://board.example.com',
                    PORT: '8080',
                    AS_BASE_URL: 'https://as.example.com',
                    RS_BASE_URL: 'https://api.example.com',
                    CLIENT_ID: 'my-board',
                    CLIENT_SECRET: 'x'.repeat(64),
                    SESSION_SECRET: 'y'.repeat(64),
                    REQUESTED_SCOPE: 'read',
                });

                expect(config).toEqual({
                    baseUrl: 'https://board.example.com',
                    port: 8080,
                    asBaseUrl: 'https://as.example.com',
                    rsBaseUrl: 'https://api.example.com',
                    clientId: 'my-board',
                    clientSecret: 'x'.repeat(64),
                    sessionSecret: 'y'.repeat(64),
                    requestedScope: 'read',
                    redirectUri: 'https://board.example.com/callback',
                    authorizationEndpoint: 'https://as.example.com/authorize',
                    tokenEndpoint: 'https://as.example.com/token',
                });
            });

            it('知らない環境変数は、無視する', () => {
                const env = {
                    ...validEnv(),
                    PATH: '/usr/bin',
                    HOME: '/home/a',
                    ISSUER: 'http://localhost:4000',
                };

                expect(loadConfig(env)).toEqual(DEFAULT_CONFIG);
            });

            it.each([
                { name: 'CLIENT_ID', key: 'clientId', expected: 'memoboard' },
                {
                    name: 'REQUESTED_SCOPE',
                    key: 'requestedScope',
                    expected: 'read write',
                },
            ])(
                '空文字は、未設定として扱う(既定値になる): $name',
                ({ name, key, expected }) => {
                    const config = loadConfig({ ...validEnv(), [name]: '' });

                    expect(config).toMatchObject({ [key]: expected });
                },
            );

            it.each([
                { value: '1', expected: 1 },
                { value: '65535', expected: 65535 },
            ])('PORT の端: $value', ({ value, expected }) => {
                const config = loadConfig({ ...validEnv(), PORT: value });

                expect(config.port).toBe(expected);
            });

            it.each([
                'http://localhost:4000',
                'https://as.example.com',
                'https://example.com/as',
                'http://127.0.0.1:4000/a/b',
            ])('AS_BASE_URL と RS_BASE_URL に使える形: %s', (value) => {
                const config = loadConfig({
                    ...validEnv(),
                    AS_BASE_URL: value,
                    RS_BASE_URL: value,
                });

                expect(config.asBaseUrl).toBe(value);
                expect(config.rsBaseUrl).toBe(value);
            });

            it('AS の URL にパスがあれば、認可とトークンのエンドポイントは、その下になる', () => {
                const config = loadConfig({
                    ...validEnv(),
                    AS_BASE_URL: 'https://example.com/as',
                });

                expect(config.authorizationEndpoint).toBe(
                    'https://example.com/as/authorize',
                );
                expect(config.tokenEndpoint).toBe(
                    'https://example.com/as/token',
                );
            });

            it.each([
                { name: '1 つだけ', value: 'read' },
                { name: '2 つ', value: 'read write' },
                { name: '記号を含む', value: 'memo:read memo.write' },
            ])('REQUESTED_SCOPE に使える形: $name', ({ value }) => {
                const config = loadConfig({
                    ...validEnv(),
                    REQUESTED_SCOPE: value,
                });

                expect(config.requestedScope).toBe(value);
            });

            it('CLIENT_ID に使える文字(英数字と _ - . ~)', () => {
                const config = loadConfig({
                    ...validEnv(),
                    CLIENT_ID: 'My_client-1.0~x',
                });

                expect(config.clientId).toBe('My_client-1.0~x');
            });

            it('CLIENT_SECRET と SESSION_SECRET は、32 文字(下限)でも通る', () => {
                const config = loadConfig({
                    ...validEnv(),
                    CLIENT_SECRET: 'a'.repeat(32),
                    SESSION_SECRET: 'b'.repeat(32),
                });

                expect(config.clientSecret).toHaveLength(32);
                expect(config.sessionSecret).toHaveLength(32);
            });
        });

        describe('throw になる場合', () => {
            it.each(REQUIRED)('必須なのに、無い: %s', (name) => {
                const env = validEnv();
                delete env[name];

                expectInvalid(env, name);
            });

            it.each(REQUIRED)('必須なのに、空文字: %s', (name) => {
                expectInvalid({ ...validEnv(), [name]: '' }, name);
            });

            it.each(['BASE_URL', 'AS_BASE_URL', 'RS_BASE_URL'])(
                '%s が、URL として不正',
                (name) => {
                    for (const value of [
                        'localhost:4001',
                        'ftp://x.example.com',
                        'not a url',
                        'http://x.example.com?a=1',
                        'http://x.example.com#f',
                        'http://localhost:4001/',
                    ])
                        expectInvalid({ ...validEnv(), [name]: value }, name);
                },
            );

            it.each([
                {
                    name: 'パスが付いている',
                    value: 'http://localhost:4001/app',
                },
                { name: 'パスが 2 段', value: 'https://example.com/a/b' },
            ])(
                'BASE_URL にパスは付けられない(/callback は、その直下にある): $name',
                ({ value }) => {
                    expectInvalid(
                        { ...validEnv(), BASE_URL: value },
                        'BASE_URL',
                    );
                },
            );

            it.each(['0', '65536', '-1', '4001.5', 'abc'])(
                'PORT が 1〜65535 の整数じゃない: %j',
                (value) => {
                    expectInvalid({ ...validEnv(), PORT: value }, 'PORT');
                },
            );

            it.each([
                { name: '空白を含む', value: 'my client' },
                { name: '日本語', value: 'メモボード' },
                { name: ':', value: 'a:b' },
                { name: '/', value: 'a/b' },
            ])('CLIENT_ID が不正: $name', ({ value }) => {
                expectInvalid({ ...validEnv(), CLIENT_ID: value }, 'CLIENT_ID');
            });

            it.each([
                { name: '31 文字', value: 'c'.repeat(31) },
                { name: '1 文字', value: 'c' },
            ])(
                'CLIENT_SECRET が短すぎる: $name(AS と同じく、下限は 32)',
                ({ value }) => {
                    expectInvalid(
                        { ...validEnv(), CLIENT_SECRET: value },
                        'CLIENT_SECRET',
                    );
                },
            );

            it.each([
                { name: '31 文字', value: 's'.repeat(31) },
                { name: '1 文字', value: 's' },
            ])('SESSION_SECRET が短すぎる: $name', ({ value }) => {
                expectInvalid(
                    { ...validEnv(), SESSION_SECRET: value },
                    'SESSION_SECRET',
                );
            });

            it.each([
                { name: '空白が 2 つ', value: 'read  write' },
                { name: '先頭に空白', value: ' read' },
                { name: '末尾に空白', value: 'read ' },
                { name: 'ダブルクォート', value: 'a"b' },
                { name: 'タブ', value: 'read\twrite' },
                { name: '日本語', value: '読む' },
            ])('REQUESTED_SCOPE が不正: $name', ({ value }) => {
                expectInvalid(
                    { ...validEnv(), REQUESTED_SCOPE: value },
                    'REQUESTED_SCOPE',
                );
            });
        });

        describe('秘密の値を、エラーのメッセージに入れない', () => {
            it('CLIENT_SECRET が短い時、その値は、メッセージに入らない', () => {
                const message = messageOf(() =>
                    loadConfig({
                        ...validEnv(),
                        CLIENT_SECRET: 'short-client-secret',
                    }),
                );

                expect(message).toContain('CLIENT_SECRET');
                expect(message).not.toContain('short-client-secret');
            });

            it('SESSION_SECRET が短い時、その値は、メッセージに入らない', () => {
                const message = messageOf(() =>
                    loadConfig({
                        ...validEnv(),
                        SESSION_SECRET: 'short-session-secret',
                    }),
                );

                expect(message).toContain('SESSION_SECRET');
                expect(message).not.toContain('short-session-secret');
            });
        });

        describe('エラーメッセージ', () => {
            it('悪い環境変数が複数あれば、全部の名前が入る', () => {
                const message = messageOf(() =>
                    loadConfig({
                        ...validEnv(),
                        BASE_URL: 'ftp://x.example.com',
                        PORT: '0',
                    }),
                );

                expect(message).toContain('BASE_URL');
                expect(message).toContain('PORT');
            });

            it('悪くない環境変数の名前は、入らない', () => {
                const message = messageOf(() =>
                    loadConfig({ ...validEnv(), PORT: '0' }),
                );

                expect(message).toContain('PORT');
                for (const other of [
                    'BASE_URL',
                    'AS_BASE_URL',
                    'RS_BASE_URL',
                    'CLIENT_ID',
                    'CLIENT_SECRET',
                    'SESSION_SECRET',
                    'REQUESTED_SCOPE',
                ])
                    expect(message).not.toContain(other);
            });
        });
    });
});
