import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const validEnv = (): Record<string, string | undefined> => ({
    ISSUER: 'http://localhost:4000',
    PORT: '4002',
    VERIFY_KEY_PATH: '../../keys/as-public.pem',
});

const DEFAULT_CONFIG = {
    issuer: 'http://localhost:4000',
    port: 4002,
    audience: 'simple-memo',
    verifyKeyPath: '../../keys/as-public.pem',
    clockToleranceSec: 0,
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

describe('CONFIG RS の環境変数の読み込み', () => {
    describe('loadConfig', () => {
        describe('読み込める例', () => {
            it('必須の 3 つだけで、残りは既定値になる', () => {
                expect(loadConfig(validEnv())).toEqual(DEFAULT_CONFIG);
            });

            it('全部指定すれば、その値になる', () => {
                const config = loadConfig({
                    ISSUER: 'https://as.example.com',
                    PORT: '8080',
                    VERIFY_KEY_PATH: '/etc/keys/public.pem',
                    AUDIENCE: 'my-api',
                    CLOCK_TOLERANCE_SEC: '30',
                });

                expect(config).toEqual({
                    issuer: 'https://as.example.com',
                    port: 8080,
                    audience: 'my-api',
                    verifyKeyPath: '/etc/keys/public.pem',
                    clockToleranceSec: 30,
                });
            });

            it('知らない環境変数は、無視する', () => {
                const env = {
                    ...validEnv(),
                    PATH: '/usr/bin',
                    HOME: '/home/a',
                    SIGNING_KEY_PATH: '../../keys/as-private.pem',
                };

                expect(loadConfig(env)).toEqual(DEFAULT_CONFIG);
            });

            it.each([
                { name: 'AUDIENCE', key: 'audience', expected: 'simple-memo' },
                {
                    name: 'CLOCK_TOLERANCE_SEC',
                    key: 'clockToleranceSec',
                    expected: 0,
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

            it.each([
                'simple-memo',
                'my api (v1)',
                'https://api.example.com/memos',
                'a',
            ])('AUDIENCE に使える形: %s', (value) => {
                const config = loadConfig({ ...validEnv(), AUDIENCE: value });

                expect(config.audience).toBe(value);
            });

            it.each([
                { value: '0', expected: 0 },
                { value: '1', expected: 1 },
                { value: '300', expected: 300 },
            ])(
                'CLOCK_TOLERANCE_SEC の範囲(0〜300): $value',
                ({ value, expected }) => {
                    const config = loadConfig({
                        ...validEnv(),
                        CLOCK_TOLERANCE_SEC: value,
                    });

                    expect(config.clockToleranceSec).toBe(expected);
                },
            );
        });

        describe('throw になる場合', () => {
            it.each(['ISSUER', 'PORT', 'VERIFY_KEY_PATH'])(
                '必須なのに、無い: %s',
                (name) => {
                    const env = validEnv();
                    delete env[name];

                    expectInvalid(env, name);
                },
            );

            it.each(['ISSUER', 'PORT', 'VERIFY_KEY_PATH'])(
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

            it.each(['0', '65536', '-1', '4002.5', 'abc'])(
                'PORT が 1〜65535 の整数じゃない: %j',
                (value) => {
                    expectInvalid({ ...validEnv(), PORT: value }, 'PORT');
                },
            );

            it.each([
                { name: 'ダブルクォート(realm に入れられない)', value: 'a"b' },
                { name: 'バックスラッシュ', value: 'a\\b' },
                { name: '改行', value: 'a\r\nb' },
                { name: 'タブ', value: 'a\tb' },
                { name: '日本語', value: 'メモ' },
            ])('AUDIENCE が不正: $name', ({ value }) => {
                expectInvalid({ ...validEnv(), AUDIENCE: value }, 'AUDIENCE');
            });

            it.each(['-1', '301', '1.5', 'abc'])(
                'CLOCK_TOLERANCE_SEC が 0〜300 の整数じゃない: %j',
                (value) => {
                    expectInvalid(
                        { ...validEnv(), CLOCK_TOLERANCE_SEC: value },
                        'CLOCK_TOLERANCE_SEC',
                    );
                },
            );
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
                    'VERIFY_KEY_PATH',
                    'AUDIENCE',
                    'CLOCK_TOLERANCE_SEC',
                ])
                    expect(message).not.toContain(other);
            });
        });
    });
});
