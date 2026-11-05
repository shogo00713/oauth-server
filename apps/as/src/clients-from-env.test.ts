import { describe, expect, it } from 'vitest';
import { loadClientsFromEnv } from './clients-from-env.js';
import { sha256Hex } from './lib/hash.js';

// ちょうど 32 文字(下限)
const SECRET = 'a'.repeat(32);
const REDIRECT_URI = 'http://localhost:3000/callback';

const validEnv = (): Record<string, string | undefined> => ({
    CLIENT_SECRET: SECRET,
    CLIENT_REDIRECT_URIS: REDIRECT_URI,
});

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
    expect(() => loadClientsFromEnv(env)).toThrow();
    expect(messageOf(() => loadClientsFromEnv(env))).toContain(name);
};

describe('CLIENTS FROM ENV 登録済みクライアントの読み込み', () => {
    describe('loadClientsFromEnv', () => {
        describe('読み込める例', () => {
            it('必須の 2 つだけで、ID と名前は、既定値になる', () => {
                expect(loadClientsFromEnv(validEnv())).toEqual([
                    {
                        clientId: 'memoboard',
                        secretHash: sha256Hex(SECRET),
                        name: 'メモボード',
                        redirectUris: [REDIRECT_URI],
                    },
                ]);
            });

            it('全部指定すれば、その値になる', () => {
                const secret = 'b'.repeat(40);

                const clients = loadClientsFromEnv({
                    CLIENT_ID: 'my-app.v2',
                    CLIENT_NAME: 'マイアプリ',
                    CLIENT_SECRET: secret,
                    CLIENT_REDIRECT_URIS: 'https://my.example.com/cb',
                });

                expect(clients).toEqual([
                    {
                        clientId: 'my-app.v2',
                        secretHash: sha256Hex(secret),
                        name: 'マイアプリ',
                        redirectUris: ['https://my.example.com/cb'],
                    },
                ]);
            });

            it('secret は、そのままじゃなくて、ハッシュで持つ', () => {
                const clients = loadClientsFromEnv(validEnv());

                expect(clients[0]?.secretHash).not.toBe(SECRET);
                expect(JSON.stringify(clients)).not.toContain(SECRET);
            });

            it('redirect_uri は、空白で区切って、複数書ける(順番も、そのまま)', () => {
                const clients = loadClientsFromEnv({
                    ...validEnv(),
                    CLIENT_REDIRECT_URIS:
                        'http://localhost:3000/callback https://my.example.com/cb',
                });

                expect(clients[0]?.redirectUris).toEqual([
                    'http://localhost:3000/callback',
                    'https://my.example.com/cb',
                ]);
            });

            it('知らない環境変数は、無視する', () => {
                const clients = loadClientsFromEnv({
                    ...validEnv(),
                    PATH: '/usr/bin',
                    HOME: '/home/a',
                });

                expect(clients).toHaveLength(1);
            });

            it.each([
                { name: 'CLIENT_ID', key: 'clientId', expected: 'memoboard' },
                { name: 'CLIENT_NAME', key: 'name', expected: 'メモボード' },
            ])(
                '空文字は、未設定として扱う(既定値になる): $name',
                ({ name, key, expected }) => {
                    const clients = loadClientsFromEnv({
                        ...validEnv(),
                        [name]: '',
                    });

                    expect(clients[0]).toMatchObject({ [key]: expected });
                },
            );
        });

        describe('throw になる場合', () => {
            it.each(['CLIENT_SECRET', 'CLIENT_REDIRECT_URIS'])(
                '必須なのに、無い: %s',
                (name) => {
                    const env = validEnv();
                    delete env[name];

                    expectInvalid(env, name);
                },
            );

            it.each(['CLIENT_SECRET', 'CLIENT_REDIRECT_URIS'])(
                '必須なのに、空文字: %s',
                (name) => {
                    expectInvalid({ ...validEnv(), [name]: '' }, name);
                },
            );

            it('secret が 31 文字(短い)', () => {
                expectInvalid(
                    { ...validEnv(), CLIENT_SECRET: 'a'.repeat(31) },
                    'CLIENT_SECRET',
                );
            });

            it.each([
                { name: '空白を含む', value: 'my app' },
                { name: 'コロンを含む', value: 'my:app' },
                { name: 'スラッシュを含む', value: 'a/b' },
                { name: '日本語', value: 'メモ' },
            ])('CLIENT_ID が不正: $name', ({ value }) => {
                expectInvalid({ ...validEnv(), CLIENT_ID: value }, 'CLIENT_ID');
            });

            it.each([
                { name: 'スキームが無い', value: 'localhost:3000/callback' },
                { name: '相対パス', value: '/callback' },
                { name: 'フラグメント付き', value: `${REDIRECT_URI}#frag` },
                { name: 'http と https 以外', value: 'ftp://x.example.com/cb' },
                { name: 'javascript:', value: 'javascript:alert(1)' },
                {
                    name: 'ユーザー名とパスワード付き',
                    value: 'http://user:pass@localhost:3000/cb',
                },
                {
                    name: '空白が 2 つ',
                    value: `${REDIRECT_URI}  https://my.example.com/cb`,
                },
                { name: '先頭に空白', value: ` ${REDIRECT_URI}` },
                { name: '末尾に空白', value: `${REDIRECT_URI} ` },
                {
                    name: '良い物に、悪い物が混ざってる',
                    value: `${REDIRECT_URI} not-a-url`,
                },
            ])('CLIENT_REDIRECT_URIS が不正: $name', ({ value }) => {
                expectInvalid(
                    { ...validEnv(), CLIENT_REDIRECT_URIS: value },
                    'CLIENT_REDIRECT_URIS',
                );
            });
        });

        describe('エラーメッセージ', () => {
            it('悪い環境変数が複数あれば、全部の名前が入る', () => {
                const message = messageOf(() =>
                    loadClientsFromEnv({
                        CLIENT_REDIRECT_URIS: 'not-a-url',
                    }),
                );

                expect(message).toContain('CLIENT_SECRET');
                expect(message).toContain('CLIENT_REDIRECT_URIS');
            });

            it('悪くない環境変数の名前は、入らない', () => {
                const message = messageOf(() =>
                    loadClientsFromEnv({
                        ...validEnv(),
                        CLIENT_SECRET: 'short',
                    }),
                );

                expect(message).toContain('CLIENT_SECRET');
                expect(message).not.toContain('CLIENT_REDIRECT_URIS');
                expect(message).not.toContain('CLIENT_ID');
                expect(message).not.toContain('CLIENT_NAME');
            });

            it('secret の値そのものは、メッセージに入らない', () => {
                const message = messageOf(() =>
                    loadClientsFromEnv({
                        ...validEnv(),
                        CLIENT_SECRET: 'too-short-secret',
                    }),
                );

                expect(message).not.toContain('too-short-secret');
            });
        });
    });
});
