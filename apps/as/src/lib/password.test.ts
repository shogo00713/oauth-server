import { beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

const PASSWORD = 'correct horse battery';

// 軽いコスト(テストを速くするため。既定のコストは、RFC 9106 4 の推奨なので、重い)
const FAST = { memoryCost: 1024, timeCost: 2, parallelism: 1 };

// PHC 形式: `$argon2id$v=19$m=...,p=...,t=...$salt$tag`
// (コストの並び順は、実装によって違うので、名前で読む)
const parsePhc = (hash: string) => {
    const [, algorithm, version, params, salt, tag] = hash.split('$');
    const costs: Record<string, string> = {};
    for (const pair of (params ?? '').split(',')) {
        const [name, value] = pair.split('=');
        if (name !== undefined && value !== undefined) costs[name] = value;
    }

    return {
        algorithm,
        version,
        m: Number(costs.m),
        t: Number(costs.t),
        p: Number(costs.p),
        salt: salt ?? '',
        tag: tag ?? '',
    };
};

// 先頭の 1 文字を、別の文字に変える(base64 の、先頭の文字は、全部のビットが使われる)
const swapFirstChar = (value: string) =>
    (value.startsWith('A') ? 'B' : 'A') + value.slice(1);

describe('PASSWORD argon2id によるパスワードのハッシュ RFC 9106 3.1 / 4', () => {
    describe('hashPassword', () => {
        describe('作れる例', () => {
            it('argon2id の PHC 形式の文字列になる', async () => {
                const phc = parsePhc(await hashPassword(PASSWORD));

                expect(phc.algorithm).toBe('argon2id');
                expect(phc.version).toBe('v=19');
            });

            it('既定のコストは、RFC 9106 4 の 2 番目の推奨(m=64MiB、t=3)以上', async () => {
                const phc = parsePhc(await hashPassword(PASSWORD));

                expect(phc.m).toBeGreaterThanOrEqual(65536);
                expect(phc.t).toBeGreaterThanOrEqual(3);
            });

            it('コストを渡したら、その値で作られる', async () => {
                const phc = parsePhc(await hashPassword(PASSWORD, FAST));

                expect(phc).toMatchObject({ m: 1024, t: 2, p: 1 });
            });

            it('salt は 16 バイト、tag は 32 バイト(RFC 9106 3.1 と 4)', async () => {
                const phc = parsePhc(await hashPassword(PASSWORD, FAST));

                expect(Buffer.from(phc.salt, 'base64')).toHaveLength(16);
                expect(Buffer.from(phc.tag, 'base64')).toHaveLength(32);
            });

            it('同じパスワードでも、毎回違うハッシュになる(salt が違う)', async () => {
                const first = await hashPassword(PASSWORD, FAST);
                const second = await hashPassword(PASSWORD, FAST);

                expect(first).not.toBe(second);
                expect(parsePhc(first).salt).not.toBe(parsePhc(second).salt);
            });

            it('ハッシュの中に、元のパスワードは入っていない', async () => {
                expect(await hashPassword(PASSWORD, FAST)).not.toContain(
                    PASSWORD,
                );
            });

            it.each([
                { name: '日本語と絵文字', value: '日本語のパスワード🔐' },
                { name: '記号だけ', value: '!@#$%^&*()_+-=[]{};:,.<>/?' },
                { name: 'NUL 文字を含む', value: 'ab\0cd1234567' },
                { name: '改行を含む', value: 'line1\nline2' },
                { name: '1 文字', value: 'a' },
                { name: '10,000 文字', value: 'x'.repeat(10_000) },
            ])(
                'いろんなパスワードを、ハッシュにして確かめられる: $name',
                async ({ value }) => {
                    const hash = await hashPassword(value, FAST);

                    expect(await verifyPassword(value, hash)).toBe(true);
                },
            );

            it('パスワードの前後の空白も、そのまま使われる(取り除かない)', async () => {
                const hash = await hashPassword(' pass word ', FAST);

                expect(await verifyPassword(' pass word ', hash)).toBe(true);
                expect(await verifyPassword('pass word', hash)).toBe(false);
            });
        });

        describe('エラーになる場合', () => {
            it('空文字は、RangeError', async () => {
                await expect(hashPassword('', FAST)).rejects.toThrow(
                    RangeError,
                );
            });
            it.each([undefined, null, 12345678, {}, [], true])(
                '文字列じゃない物は、TypeError: %j',
                async (value) => {
                    await expect(
                        hashPassword(value as unknown as string, FAST),
                    ).rejects.toThrow(TypeError);
                },
            );

            it.each([
                { name: 'メモリが 1(小さすぎる)', costs: { memoryCost: 1 } },
                { name: 'メモリが 0', costs: { memoryCost: 0 } },
                { name: '回数が 0', costs: { timeCost: 0 } },
                { name: '並列が 0', costs: { parallelism: 0 } },
            ])(
                'コストが小さすぎたら、黙って既定値にせず、エラーになる: $name',
                async ({ costs }) => {
                    // 比べるために、ちゃんとしたコストなら、作れること
                    expect(await hashPassword(PASSWORD, FAST)).toMatch(
                        /^\$argon2id\$/,
                    );

                    await expect(
                        hashPassword(PASSWORD, { ...FAST, ...costs }),
                    ).rejects.toThrow();
                },
            );
        });
    });

    describe('verifyPassword', () => {
        let hash = '';

        // (軽いコストなので、毎回作り直しても、速い)
        beforeEach(async () => {
            hash = await hashPassword(PASSWORD, FAST);
        });

        describe('確かめられる例', () => {
            it('正しいパスワードなら、true', async () => {
                expect(await verifyPassword(PASSWORD, hash)).toBe(true);
            });

            it('既定のコストで作ったハッシュも、確かめられる', async () => {
                const defaultHash = await hashPassword(PASSWORD);

                expect(await verifyPassword(PASSWORD, defaultHash)).toBe(true);
            });

            it('コストが違うハッシュも、同じ関数で確かめられる(コストは、ハッシュの中に入っている)', async () => {
                const otherCosts = await hashPassword(PASSWORD, {
                    memoryCost: 2048,
                    timeCost: 1,
                    parallelism: 2,
                });

                expect(await verifyPassword(PASSWORD, otherCosts)).toBe(true);
                expect(await verifyPassword(PASSWORD, hash)).toBe(true);
            });

            it('同時に何回呼んでも、全部正しい', async () => {
                const results = await Promise.all([
                    verifyPassword(PASSWORD, hash),
                    verifyPassword('wrong password', hash),
                    verifyPassword(PASSWORD, hash),
                    verifyPassword('', hash),
                ]);

                expect(results).toEqual([true, false, true, false]);
            });
        });

        describe('false になる場合', () => {
            it.each([
                { name: '大文字小文字が違う', value: 'Correct horse battery' },
                { name: 'すべて大文字', value: 'CORRECT HORSE BATTERY' },
                { name: '末尾に空白', value: `${PASSWORD} ` },
                { name: '先頭に空白', value: ` ${PASSWORD}` },
                { name: '途中までしかない', value: 'correct horse' },
                { name: '後ろに足してある', value: `${PASSWORD}!` },
                { name: '全然違う', value: 'wrong password' },
            ])('違うパスワード: $name', async ({ value }) => {
                expect(await verifyPassword(value, hash)).toBe(false);
            });

            it('空文字のパスワードは、false', async () => {
                expect(await verifyPassword('', hash)).toBe(false);
            });

            it('別のパスワードのハッシュでは、false', async () => {
                const other = await hashPassword('another password 1', FAST);

                expect(await verifyPassword(PASSWORD, other)).toBe(false);
            });

            it.each([undefined, null, 12345678, {}, [], true])(
                'パスワードが文字列じゃない: %j(例外にならない)',
                async (value) => {
                    expect(await verifyPassword(value, hash)).toBe(false);
                },
            );

            it.each([undefined, null, 12345678, {}, [], true])(
                'ハッシュが文字列じゃない: %j(例外にならない)',
                async (value) => {
                    expect(await verifyPassword(PASSWORD, value)).toBe(false);
                },
            );

            it.each([
                { name: '空文字', value: '' },
                { name: '$ だけ', value: '$' },
                { name: 'ハッシュじゃない文字列', value: 'not-a-hash' },
                { name: '平文のパスワード', value: PASSWORD },
                { name: '$argon2id$ だけ', value: '$argon2id$' },
                {
                    name: 'salt と tag が短い',
                    value: '$argon2id$v=19$m=1024,p=1,t=2$AAAA$BBBB',
                },
            ])('壊れたハッシュ: $name(例外にならない)', async ({ value }) => {
                expect(await verifyPassword(PASSWORD, value)).toBe(false);
            });

            it.each([
                {
                    name: '途中で切れている',
                    tamper: (value: string) => value.slice(0, -10),
                },
                {
                    name: 'tag の先頭を書き換える',
                    tamper: (value: string) => {
                        const parts = value.split('$');
                        parts[5] = swapFirstChar(parts[5] ?? '');
                        return parts.join('$');
                    },
                },
                {
                    name: 'salt の先頭を書き換える',
                    tamper: (value: string) => {
                        const parts = value.split('$');
                        parts[4] = swapFirstChar(parts[4] ?? '');
                        return parts.join('$');
                    },
                },
                {
                    name: 'コストを書き換える',
                    tamper: (value: string) => value.replace(/m=\d+/, 'm=1025'),
                },
            ])(
                '書き換えられたハッシュ: $name(例外にならない)',
                async ({ tamper }) => {
                    expect(await verifyPassword(PASSWORD, tamper(hash))).toBe(
                        false,
                    );
                },
            );
        });
    });
});
