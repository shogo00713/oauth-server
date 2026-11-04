import { describe, it, expect } from 'vitest';
import { loadConfig } from './config.js';

const validEnv = (): Record<string, string | undefined> => ({
    ISSUER: 'http://localhost:4000',
    PORT: '4000',
    SIGNING_KEY_PATH: '../../keys/as-private.pem',
});

const DEFAULT_CONFIG = {
    issuer: 'http://localhost:4000',
    port: 4000,
    audience: 'simple-memo',
    signingKeyPath: '../../keys/as-private.pem',
    codeTtlSec: 60,
    accessTokenTtlSec: 600,
    defaultScope: ['read'],
};

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

describe('CONFIG 環境変数の読み込み', () => {
    describe('loadConfig', () => {
        describe('読み込める例', () => {
            it('必須の 3 つだけで、残りは既定値になる', () => {
                expect(loadConfig(validEnv())).toEqual(DEFAULT_CONFIG);
            });

            it('全部指定すれば、その値になる', () => {
                const config = loadConfig({
                    ISSUER: 'https://as.example.com',
                    PORT: '8080',
                    SIGNING_KEY_PATH: '/etc/keys/private.pem',
                    AUDIENCE: 'my-api',
                    CODE_TTL_SEC: '30',
                    ACCESS_TOKEN_TTL_SEC: '3600',
                    DEFAULT_SCOPE: 'write read',
                });

                expect(config).toEqual({
                    issuer: 'https://as.example.com',
                    port: 8080,
                    audience: 'my-api',
                    signingKeyPath: '/etc/keys/private.pem',
                    codeTtlSec: 30,
                    accessTokenTtlSec: 3600,
                    defaultScope: ['read', 'write'],
                });
            });

            it('知らない環境変数は、無視する', () => {
                const env = {
                    ...validEnv(),
                    PATH: '/usr/bin',
                    HOME: '/home/a',
                };

                expect(loadConfig(env)).toEqual(DEFAULT_CONFIG);
            });

            it.each([
                { name: 'AUDIENCE', key: 'audience', expected: 'simple-memo' },
                { name: 'CODE_TTL_SEC', key: 'codeTtlSec', expected: 60 },
                {
                    name: 'ACCESS_TOKEN_TTL_SEC',
                    key: 'accessTokenTtlSec',
                    expected: 600,
                },
                {
                    name: 'DEFAULT_SCOPE',
                    key: 'defaultScope',
                    expected: ['read'],
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
            ])('ISSUER に使える形: %s', (value) => {
                const config = loadConfig({ ...validEnv(), ISSUER: value });

                expect(config.issuer).toBe(value);
            });

            it('TTL は、1 秒から指定できる', () => {
                const config = loadConfig({
                    ...validEnv(),
                    CODE_TTL_SEC: '1',
                    ACCESS_TOKEN_TTL_SEC: '1',
                });

                expect(config.codeTtlSec).toBe(1);
                expect(config.accessTokenTtlSec).toBe(1);
            });

            it.each([
                { name: '1 つだけ', value: 'write', expected: ['write'] },
                {
                    name: '順番がバラバラ(並べ直される)',
                    value: 'write read',
                    expected: ['read', 'write'],
                },
                {
                    name: '重複(1 つにまとまる)',
                    value: 'read read write',
                    expected: ['read', 'write'],
                },
            ])('DEFAULT_SCOPE: $name', ({ value, expected }) => {
                const config = loadConfig({
                    ...validEnv(),
                    DEFAULT_SCOPE: value,
                });

                expect(config.defaultScope).toEqual(expected);
            });
        });

        describe('throw になる場合', () => {
            it.each(['ISSUER', 'PORT', 'SIGNING_KEY_PATH'])(
                '必須なのに、無い: %s',
                (name) => {
                    const env = validEnv();
                    delete env[name];

                    expectInvalid(env, name);
                },
            );

            it.each(['ISSUER', 'PORT', 'SIGNING_KEY_PATH'])(
                '必須なのに、空文字: %s',
                (name) => {
                    expectInvalid({ ...validEnv(), [name]: '' }, name);
                },
            );

            it.each([
                { name: '末尾が /', value: 'http://localhost:4000/' },
                { name: 'スキームが無い', value: 'localhost:4000' },
                { name: 'http と https 以外', value: 'ftp://x.example.com' },
                { name: 'クエリ付き', value: 'http://x.example.com?a=1' },
                { name: 'フラグメント付き', value: 'http://x.example.com#f' },
                { name: 'URL じゃない', value: 'not a url' },
            ])('ISSUER が不正: $name', ({ value }) => {
                expectInvalid({ ...validEnv(), ISSUER: value }, 'ISSUER');
            });

            it.each(['0', '65536', '-1', '4000.5', 'abc'])(
                'PORT が 1〜65535 の整数じゃない: %j',
                (value) => {
                    expectInvalid({ ...validEnv(), PORT: value }, 'PORT');
                },
            );

            describe.each(['CODE_TTL_SEC', 'ACCESS_TOKEN_TTL_SEC'])(
                '%s',
                (name) => {
                    it.each(['0', '-1', '1.5', 'abc'])(
                        '正の整数じゃない: %j',
                        (value) => {
                            expectInvalid(
                                { ...validEnv(), [name]: value },
                                name,
                            );
                        },
                    );
                },
            );

            it.each([
                { name: '空白が 2 つ', value: 'read  write' },
                { name: '先頭に空白', value: ' read' },
                { name: '末尾に空白', value: 'read ' },
                { name: 'ダブルクォート', value: 'a"b' },
                { name: 'タブ', value: 'read\twrite' },
                { name: '日本語', value: '読む' },
            ])('DEFAULT_SCOPE が不正: $name', ({ value }) => {
                expectInvalid(
                    { ...validEnv(), DEFAULT_SCOPE: value },
                    'DEFAULT_SCOPE',
                );
            });
        });

        describe('エラーメッセージ', () => {
            it('悪い環境変数が複数あれば、全部の名前が入る', () => {
                const message = messageOf(() =>
                    loadConfig({
                        ...validEnv(),
                        ISSUER: 'ftp://x.example.com',
                        PORT: '0',
                    }),
                );

                expect(message).toContain('ISSUER');
                expect(message).toContain('PORT');
            });

            it('悪くない環境変数の名前は、入らない', () => {
                const message = messageOf(() =>
                    loadConfig({ ...validEnv(), PORT: '0' }),
                );

                expect(message).toContain('PORT');
                for (const other of [
                    'ISSUER',
                    'SIGNING_KEY_PATH',
                    'AUDIENCE',
                    'CODE_TTL_SEC',
                    'ACCESS_TOKEN_TTL_SEC',
                    'DEFAULT_SCOPE',
                ])
                    expect(message).not.toContain(other);
            });
        });
    });
});
