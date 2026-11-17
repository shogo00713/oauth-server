import { describe, expect, it } from 'vitest';
import { loadClientsFromEnv } from './clients-from-env.js';
import { sha256Hex } from './lib/hash.js';

// 既定値は無いので、昔の既定値(memoboard、メモボード)とは違う値を使う
const CLIENT_ID = 'test-client';
const CLIENT_NAME = 'テストクライアント';
// ちょうど 32 文字(下限)
const SECRET = 'a'.repeat(32);
const REDIRECT_URI = 'http://localhost:3000/callback';

// 4 つとも必須(既定値は無い)
const REQUIRED = [
    'CLIENT_ID',
    'CLIENT_NAME',
    'CLIENT_SECRET',
    'CLIENT_REDIRECT_URIS',
] as const;

const validEnv = (): Record<string, string | undefined> => ({
    CLIENT_ID,
    CLIENT_NAME,
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
            it('4 つ全部を指定すれば、その値になる(クライアントは 1 つ)', () => {
                expect(loadClientsFromEnv(validEnv())).toEqual([
                    {
                        clientId: CLIENT_ID,
                        secretHash: sha256Hex(SECRET),
                        name: CLIENT_NAME,
                        redirectUris: [REDIRECT_URI],
                    },
                ]);
            });

            it('別の値を指定すれば、別の値になる', () => {
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
                { name: '1 文字', value: 'a' },
                { name: '英数字と、使える記号(_ . - ~)', value: 'A_b.c-9~' },
            ])('CLIENT_ID に使える: $name', ({ value }) => {
                const clients = loadClientsFromEnv({
                    ...validEnv(),
                    CLIENT_ID: value,
                });

                expect(clients[0]?.clientId).toBe(value);
            });

            it('CLIENT_NAME は、空白や日本語を含んでいても、そのまま', () => {
                const clients = loadClientsFromEnv({
                    ...validEnv(),
                    CLIENT_NAME: 'My アプリ 2',
                });

                expect(clients[0]?.name).toBe('My アプリ 2');
            });
        });

        describe('throw になる場合', () => {
            it.each(REQUIRED)('必須(既定値は無い)なのに、無い: %s', (name) => {
                const env = validEnv();
                delete env[name];

                expectInvalid(env, name);
            });

            it.each(REQUIRED)(
                '必須(既定値は無い)なのに、空文字: %s',
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
                { name: '改行を含む', value: 'my\napp' },
                { name: '末尾が改行', value: 'my-app\n' },
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
            it('何も無ければ、4 つ全部の名前が入る', () => {
                const message = messageOf(() => loadClientsFromEnv({}));

                for (const name of REQUIRED) {
                    expect(message).toContain(name);
                }
            });

            it('悪い環境変数が複数あれば、全部の名前が入る', () => {
                const message = messageOf(() =>
                    loadClientsFromEnv({
                        CLIENT_ID,
                        CLIENT_NAME,
                        CLIENT_SECRET: 'short',
                        CLIENT_REDIRECT_URIS: 'not-a-url',
                    }),
                );

                expect(message).toContain('CLIENT_SECRET');
                expect(message).toContain('CLIENT_REDIRECT_URIS');
                expect(message).not.toContain('CLIENT_ID');
                expect(message).not.toContain('CLIENT_NAME');
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

            it('「環境変数が不正です」と、書いてある', () => {
                const message = messageOf(() => loadClientsFromEnv({}));

                expect(message).toContain('環境変数が不正です');
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
