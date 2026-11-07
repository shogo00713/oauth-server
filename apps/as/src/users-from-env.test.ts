import { describe, expect, it } from 'vitest';
import { verifyPassword } from './lib/password.js';
import { loadUsersFromEnv } from './users-from-env.js';

// ちょうど 12 文字(下限)
const PASSWORD = 'a1b2c3d4e5f6';

const validEnv = (): Record<string, string | undefined> => ({
    USER_PASSWORD: PASSWORD,
});

// 失敗した時の、エラーのメッセージ(失敗しなかったら、空文字)
const rejectionMessage = async (promise: Promise<unknown>): Promise<string> => {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    return '';
};

// 失敗すること、そして、悪い環境変数の名前が、メッセージに入っていること
const expectInvalid = async (
    env: Record<string, string | undefined>,
    name: string,
) => {
    await expect(loadUsersFromEnv(env)).rejects.toThrow();
    expect(await rejectionMessage(loadUsersFromEnv(env))).toContain(name);
};

describe('USERS FROM ENV 登録済みユーザーの読み込み', () => {
    describe('loadUsersFromEnv', () => {
        describe('読み込める例', () => {
            it('パスワードだけで、名前は demo になる(ユーザーは 1 人)', async () => {
                const users = await loadUsersFromEnv(validEnv());

                expect(users).toHaveLength(1);
                expect(users[0]?.username).toBe('demo');
            });

            it('名前も指定すれば、その名前になる', async () => {
                const users = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: 'alice.v2',
                });

                expect(users[0]?.username).toBe('alice.v2');
            });

            it('持っている項目は、id、username、passwordHash だけ(平文のパスワードの項目は無い)', async () => {
                const [user] = await loadUsersFromEnv(validEnv());

                expect(Object.keys(user ?? {}).sort()).toEqual([
                    'id',
                    'passwordHash',
                    'username',
                ]);
            });

            it('パスワードは、そのままじゃなくて、argon2id のハッシュで持つ', async () => {
                const users = await loadUsersFromEnv(validEnv());

                expect(users[0]?.passwordHash).toMatch(/^\$argon2id\$/);
                expect(JSON.stringify(users)).not.toContain(PASSWORD);
            });

            it('持っているハッシュで、元のパスワードが確かめられる(違うパスワードは、通らない)', async () => {
                const [user] = await loadUsersFromEnv(validEnv());

                expect(await verifyPassword(PASSWORD, user?.passwordHash)).toBe(
                    true,
                );
                expect(
                    await verifyPassword('a1b2c3d4e5f7', user?.passwordHash),
                ).toBe(false);
            });

            it('パスワードの前後の空白も、そのまま使われる(取り除かない)', async () => {
                const [user] = await loadUsersFromEnv({
                    USER_PASSWORD: '  pass word 12  ',
                });

                expect(
                    await verifyPassword(
                        '  pass word 12  ',
                        user?.passwordHash,
                    ),
                ).toBe(true);
                expect(
                    await verifyPassword('pass word 12', user?.passwordHash),
                ).toBe(false);
            });

            it('日本語のパスワードも、使える', async () => {
                const password = 'あ'.repeat(12);

                const [user] = await loadUsersFromEnv({
                    USER_PASSWORD: password,
                });

                expect(await verifyPassword(password, user?.passwordHash)).toBe(
                    true,
                );
            });

            it('知らない環境変数は、無視する', async () => {
                const users = await loadUsersFromEnv({
                    ...validEnv(),
                    PATH: '/usr/bin',
                    HOME: '/home/a',
                    CLIENT_SECRET: 'x',
                });

                expect(users).toHaveLength(1);
            });

            it('USER_NAME が空文字なら、未設定として扱う(demo になる)', async () => {
                const users = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: '',
                });

                expect(users[0]?.username).toBe('demo');
            });

            it('呼ぶたびに、ハッシュは違う(salt が違う)けど、どれも確かめられる', async () => {
                const [first] = await loadUsersFromEnv(validEnv());
                const [second] = await loadUsersFromEnv(validEnv());

                expect(first?.passwordHash).not.toBe(second?.passwordHash);
                expect(
                    await verifyPassword(PASSWORD, first?.passwordHash),
                ).toBe(true);
                expect(
                    await verifyPassword(PASSWORD, second?.passwordHash),
                ).toBe(true);
            });
        });

        describe('ID', () => {
            it('32 文字の、16 進数', async () => {
                const [user] = await loadUsersFromEnv(validEnv());

                expect(user?.id).toMatch(/^[0-9a-f]{32}$/);
            });

            it('呼ぶたびに、同じ(起動のたびに、変わらない)', async () => {
                const [first] = await loadUsersFromEnv(validEnv());
                const [second] = await loadUsersFromEnv(validEnv());

                expect(first?.id).toBe(second?.id);
            });

            it('パスワードが変わっても、同じ', async () => {
                const [first] = await loadUsersFromEnv(validEnv());
                const [second] = await loadUsersFromEnv({
                    USER_PASSWORD: 'z9y8x7w6v5u4',
                });

                expect(first?.id).toBe(second?.id);
            });

            it('username が違えば、違う', async () => {
                const [alice] = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: 'alice',
                });
                const [bob] = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: 'bob',
                });

                expect(alice?.id).not.toBe(bob?.id);
            });

            it('大文字小文字が違う username も、別の人(違う ID)', async () => {
                const [lower] = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: 'alice',
                });
                const [upper] = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: 'ALICE',
                });

                expect(lower?.id).not.toBe(upper?.id);
            });

            it('USER_NAME を省略した時の ID は、USER_NAME=demo と同じ(省略した時の名前が demo なので)', async () => {
                const [omitted] = await loadUsersFromEnv(validEnv());
                const [explicit] = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: 'demo',
                });

                expect(omitted?.username).toBe('demo');
                expect(omitted?.id).toBe(explicit?.id);
            });
        });

        describe('USER_NAME が不正', () => {
            it.each([
                { name: '空白を含む', value: 'a b' },
                { name: '記号(!)を含む', value: 'alice!' },
                { name: '記号(@)を含む', value: 'alice@example.com' },
                { name: 'スラッシュを含む', value: 'a/b' },
                { name: 'ドットとスラッシュ', value: '../x' },
                { name: '日本語', value: 'アリス' },
                { name: '前後に空白', value: ' alice ' },
                { name: '改行を含む', value: 'alice\nbob' },
                { name: '65 文字(上限は 64)', value: 'a'.repeat(65) },
            ])('使えない名前: $name', async ({ value }) => {
                await expectInvalid(
                    { ...validEnv(), USER_NAME: value },
                    'USER_NAME',
                );
            });

            it.each([
                { name: '1 文字', value: 'a' },
                { name: '64 文字(上限)', value: 'a'.repeat(64) },
                { name: '使える記号(_ . -)と数字', value: 'A_b.c-9' },
                {
                    name: '~ も使える(RFC 3986 の、予約されていない文字)',
                    value: 'a~b',
                },
            ])('使える名前: $name', async ({ value }) => {
                const users = await loadUsersFromEnv({
                    ...validEnv(),
                    USER_NAME: value,
                });

                expect(users[0]?.username).toBe(value);
            });
        });

        describe('USER_PASSWORD が不正', () => {
            it('無い', async () => {
                await expectInvalid({}, 'USER_PASSWORD');
            });

            it('空文字(未設定として扱うので、無いのと同じ)', async () => {
                await expectInvalid({ USER_PASSWORD: '' }, 'USER_PASSWORD');
            });

            it('11 文字(下限は 12)', async () => {
                await expectInvalid(
                    { USER_PASSWORD: 'a'.repeat(11) },
                    'USER_PASSWORD',
                );
            });

            it('12 文字(下限)なら、通る', async () => {
                const users = await loadUsersFromEnv({
                    USER_PASSWORD: 'a'.repeat(12),
                });

                expect(users).toHaveLength(1);
            });
        });

        describe('エラーのメッセージ', () => {
            it('両方が不正なら、両方の名前が入る', async () => {
                const message = await rejectionMessage(
                    loadUsersFromEnv({ USER_NAME: 'a b', USER_PASSWORD: 'x' }),
                );

                expect(message).toContain('USER_NAME');
                expect(message).toContain('USER_PASSWORD');
            });

            it('短すぎるパスワードの値は、メッセージに入らない', async () => {
                const message = await rejectionMessage(
                    loadUsersFromEnv({ USER_PASSWORD: 'secret-pw-1' }),
                );

                // 何が悪いかは、書いてある(名前は入る)けど、値は入らない
                expect(message).toContain('USER_PASSWORD');
                expect(message).not.toContain('secret-pw-1');
            });

            it('名前が不正でも、(正しい)パスワードの値は、メッセージに入らない', async () => {
                const message = await rejectionMessage(
                    loadUsersFromEnv({
                        USER_NAME: 'a b',
                        USER_PASSWORD: PASSWORD,
                    }),
                );

                expect(message).toContain('USER_NAME');
                expect(message).not.toContain(PASSWORD);
            });
        });
    });
});
