/**
 * M1 の完了条件: RS(docs/milestones/m1.md の「RS」)
 *   - JWT の検証
 *   - Bearer 形式での認証
 *   - 入力検証(zod)
 *   - スコープの判定と検証
 * 本物の RS を起動して、HTTP で直接たたく。トークンは、AS の鍵で、テストが作る
 * (偽物や、期限切れや、宛先違いも、作れる)。本物の AS が出したトークンでも、1 回確かめる
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    hmacTokenSignedWithPublicKey,
    mintAccessToken,
    tamperPayload,
    unsignedToken,
    type MintOptions,
} from './helpers/jwt.js';
import { callRs, obtainToken, type MemoJson } from './helpers/oauth.js';
import { startStack, type Stack } from './helpers/stack.js';

let stack: Stack;

beforeAll(async () => {
    stack = await startStack();
});

afterAll(async () => {
    await stack.stop();
});

// AS の鍵で署名した、正しいトークン(上書きしたい所だけ、書く)
const mint = (overrides: Partial<MintOptions> = {}) =>
    mintAccessToken({
        privateKeyPem: stack.privateKeyPem,
        issuer: stack.issuer,
        audience: stack.audience,
        sub: `user-${randomUUID()}`,
        scope: 'read write',
        ...overrides,
    });

const memosOf = (json: unknown) => (json as { memos: MemoJson[] }).memos;

describe('M1-RS Bearer 形式での認証', () => {
    it('本物の AS が出したトークンで、メモの一覧が取れる', async () => {
        const { accessToken } = await obtainToken(stack);

        const response = await callRs(stack, { token: accessToken });

        expect(response.status).toBe(200);
        expect(Array.isArray(memosOf(response.json))).toBe(true);
    });

    it('Authorization ヘッダーが無いと、401。WWW-Authenticate: Bearer に realm だけ(error は付けない)', async () => {
        const response = await callRs(stack);

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer realm="simple-memo"',
        );
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('Bearer ではない方式(Basic)だと、401(認証情報が無いのと同じ)', async () => {
        const response = await callRs(stack, {
            headers: { Authorization: 'Basic ZGVtbzpkZW1v' },
        });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toBe(
            'Bearer realm="simple-memo"',
        );
    });

    it('URL のクエリに付けたトークンは、受け付けない(Authorization ヘッダーだけ)', async () => {
        const response = await callRs(stack, {
            path: `/memos?access_token=${mint()}`,
        });

        expect(response.status).toBe(401);
    });

    it('JWT ではない文字列を Bearer に付けると、401 invalid_token', async () => {
        const response = await callRs(stack, { token: 'not-a-jwt' });

        expect(response.status).toBe(401);
        expect(response.headers.get('www-authenticate')).toContain(
            'error="invalid_token"',
        );
    });
});

describe('M1-RS JWT の検証', () => {
    // 断られるべきトークン(関数にして、beforeAll のあとで、作る)
    const rejected: { name: string; token: () => string }[] = [
        {
            name: '別の鍵で署名した(偽物)',
            token: () =>
                mint({
                    privateKeyPem: generateKeyPairSync('rsa', {
                        modulusLength: 2048,
                        publicKeyEncoding: { type: 'spki', format: 'pem' },
                        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
                    }).privateKey,
                }),
        },
        {
            name: '本体を書き換えた(署名が合わない)',
            token: () =>
                tamperPayload(mint({ scope: 'read' }), { scope: 'read write' }),
        },
        { name: '期限切れ', token: () => mint({ expiresInSec: -60 }) },
        {
            name: '宛先(aud)が、別のサービス',
            token: () => mint({ audience: 'another-service' }),
        },
        {
            name: '発行者(iss)が、別の AS',
            token: () => mint({ issuer: 'http://localhost:1' }),
        },
        {
            name: '署名が無い(alg=none)',
            token: () =>
                unsignedToken({
                    iss: stack.issuer,
                    aud: stack.audience,
                    sub: 'attacker',
                    client_id: stack.clientId,
                    scope: 'read write',
                    exp: Math.floor(Date.now() / 1000) + 300,
                }),
        },
        {
            name: '公開鍵を HMAC の秘密にして署名した(alg=HS256)',
            token: () =>
                hmacTokenSignedWithPublicKey(
                    {
                        iss: stack.issuer,
                        aud: stack.audience,
                        sub: 'attacker',
                        client_id: stack.clientId,
                        scope: 'read write',
                        exp: Math.floor(Date.now() / 1000) + 300,
                    },
                    stack.publicKeyPem,
                ),
        },
        {
            name: 'typ が at+jwt ではない',
            token: () => mint({ header: { typ: 'JWT' } }),
        },
        {
            name: 'sub が無い',
            token: () => mint({ payload: { sub: undefined } }),
        },
        {
            name: 'exp が無い',
            token: () => mint({ payload: { exp: undefined } }),
        },
        {
            name: 'scope が無い',
            token: () => mint({ payload: { scope: undefined } }),
        },
    ];

    it.each(rejected)(
        '$name トークンは、401 invalid_token',
        async ({ token }) => {
            const response = await callRs(stack, { token: token() });

            expect(response.status).toBe(401);
            expect(response.headers.get('www-authenticate')).toContain(
                'error="invalid_token"',
            );
            expect(response.json).not.toHaveProperty('memos');
        },
    );

    it('断られたトークンでは、作る、書き換える、消すも、できない(何も変わらない)', async () => {
        const owner = `user-${randomUUID()}`;
        const token = mint({ sub: owner });
        const created = await callRs(stack, {
            token,
            method: 'POST',
            json: { body: 'keep' },
        });
        const { id } = created.json as MemoJson;
        const expired = mint({ sub: owner, expiresInSec: -60 });

        const put = await callRs(stack, {
            token: expired,
            method: 'PUT',
            path: `/memos/${id}`,
            json: { body: 'changed' },
        });
        const del = await callRs(stack, {
            token: expired,
            method: 'DELETE',
            path: `/memos/${id}`,
        });
        const post = await callRs(stack, {
            token: expired,
            method: 'POST',
            json: { body: 'new' },
        });

        expect([put.status, del.status, post.status]).toEqual([401, 401, 401]);
        const read = await callRs(stack, { token, path: `/memos/${id}` });
        expect(read.json).toMatchObject({ id, body: 'keep' });
        expect(memosOf((await callRs(stack, { token })).json)).toHaveLength(1);
    });
});

describe('M1-RS スコープの判定', () => {
    it('read だけのトークン: 読めるが、作る、書き換える、消すは、403 insufficient_scope(必要な scope=write を伝える)', async () => {
        const owner = `user-${randomUUID()}`;
        const writer = mint({ sub: owner, scope: 'read write' });
        const reader = mint({ sub: owner, scope: 'read' });
        const created = await callRs(stack, {
            token: writer,
            method: 'POST',
            json: { body: 'by writer' },
        });
        const { id } = created.json as MemoJson;

        const list = await callRs(stack, { token: reader });
        const one = await callRs(stack, {
            token: reader,
            path: `/memos/${id}`,
        });
        const forbidden = [
            await callRs(stack, {
                token: reader,
                method: 'POST',
                json: { body: 'x' },
            }),
            await callRs(stack, {
                token: reader,
                method: 'PUT',
                path: `/memos/${id}`,
                json: { body: 'x' },
            }),
            await callRs(stack, {
                token: reader,
                method: 'DELETE',
                path: `/memos/${id}`,
            }),
        ];

        expect(list.status).toBe(200);
        expect(one.status).toBe(200);
        for (const response of forbidden) {
            expect(response.status).toBe(403);
            const challenge = response.headers.get('www-authenticate') ?? '';
            expect(challenge).toMatch(/^Bearer /);
            expect(challenge).toContain('realm="simple-memo"');
            expect(challenge).toContain('scope="write"');
            expect(challenge).toContain('error="insufficient_scope"');
            expect(response.json).toMatchObject({
                error: 'insufficient_scope',
            });
        }
        // 何も変わっていない
        const after = await callRs(stack, {
            token: writer,
            path: `/memos/${id}`,
        });
        expect(after.json).toMatchObject({ id, body: 'by writer' });
        expect(
            memosOf((await callRs(stack, { token: writer })).json),
        ).toHaveLength(1);
    });

    it('write のトークン: 読むことも、書くことも、できる(write は read を含む)', async () => {
        const token = mint({ scope: 'write' });

        const post = await callRs(stack, {
            token,
            method: 'POST',
            json: { body: 'x' },
        });
        const list = await callRs(stack, { token });

        expect(post.status).toBe(201);
        expect(list.status).toBe(200);
    });

    it('知らないスコープだけのトークンは、何もできない(403)', async () => {
        const token = mint({ scope: 'admin' });

        const list = await callRs(stack, { token });
        const post = await callRs(stack, {
            token,
            method: 'POST',
            json: { body: 'x' },
        });

        expect(list.status).toBe(403);
        expect(post.status).toBe(403);
    });

    it('AS が出した read だけのトークンでも、同じ(本物のトークンで確かめる)', async () => {
        const { accessToken } = await obtainToken(stack, { scope: 'read' });

        const list = await callRs(stack, { token: accessToken });
        const post = await callRs(stack, {
            token: accessToken,
            method: 'POST',
            json: { body: 'x' },
        });

        expect(list.status).toBe(200);
        expect(post.status).toBe(403);
    });
});

describe('M1-RS 入力検証(zod)', () => {
    const invalidBodies: { name: string; raw?: string; json?: unknown }[] = [
        { name: 'body が無い', json: {} },
        { name: 'body が空文字', json: { body: '' } },
        { name: 'body が数値', json: { body: 123 } },
        { name: 'body が null', json: { body: null } },
        { name: 'body が配列', json: { body: ['a'] } },
        {
            name: 'body が 10001 文字(最大 10000)',
            json: { body: 'a'.repeat(10_001) },
        },
        { name: '本体が配列', json: [{ body: 'a' }] },
        { name: '本体が文字列', json: 'a' },
        { name: 'JSON が壊れている', raw: '{"body": ' },
        { name: '本体が空', raw: '' },
    ];

    it.each(invalidBodies)(
        '作成: $name と、400。何も作られない',
        async ({ raw, json }) => {
            const token = mint();

            const response = await callRs(stack, {
                token,
                method: 'POST',
                ...(raw === undefined ? { json } : { raw }),
            });

            expect(response.status).toBe(400);
            expect(memosOf((await callRs(stack, { token })).json)).toEqual([]);
        },
    );

    it.each(invalidBodies)(
        '更新: $name と、400。元のメモは、そのまま',
        async ({ raw, json }) => {
            const token = mint();
            const created = await callRs(stack, {
                token,
                method: 'POST',
                json: { body: 'original' },
            });
            const { id } = created.json as MemoJson;

            const response = await callRs(stack, {
                token,
                method: 'PUT',
                path: `/memos/${id}`,
                ...(raw === undefined ? { json } : { raw }),
            });

            expect(response.status).toBe(400);
            const read = await callRs(stack, { token, path: `/memos/${id}` });
            expect(read.json).toMatchObject({ id, body: 'original' });
        },
    );

    it('境界: 1 文字と、10000 文字は、良い。絵文字は、1 文字と数える(10000 個まで)', async () => {
        const token = mint();

        const bodies = ['a', 'a'.repeat(10_000), '😀'.repeat(10_000)];

        for (const body of bodies) {
            const response = await callRs(stack, {
                token,
                method: 'POST',
                json: { body },
            });
            expect(response.status).toBe(201);
            expect((response.json as MemoJson).body).toBe(body);
        }
        const tooMany = await callRs(stack, {
            token,
            method: 'POST',
            json: { body: '😀'.repeat(10_001) },
        });
        expect(tooMany.status).toBe(400);
    });

    it('壊れた文字(孤立したサロゲート)は、400。文字化けして保存されることは、無い', async () => {
        const token = mint();
        const backslash = String.fromCharCode(0x5c);

        const response = await callRs(stack, {
            token,
            method: 'POST',
            raw: `{"body":"a${backslash}ud83db"}`,
        });

        expect(response.status).toBe(400);
        expect(memosOf((await callRs(stack, { token })).json)).toEqual([]);
    });

    it('知らない項目(owner、id、日時)は、捨てられる。持ち主は、いつもトークンの sub', async () => {
        const owner = `user-${randomUUID()}`;
        const token = mint({ sub: owner });

        const response = await callRs(stack, {
            token,
            method: 'POST',
            json: {
                body: 'x',
                owner: 'someone-else',
                id: 'chosen-by-client',
                createdAt: '2000-01-01T00:00:00.000Z',
            },
        });

        expect(response.status).toBe(201);
        const memo = response.json as MemoJson;
        expect(memo.id).not.toBe('chosen-by-client');
        expect(memo.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
        // 持ち主は、トークンの sub: 自分の一覧に出て、別の人の一覧には出ない
        expect(memosOf((await callRs(stack, { token })).json)).toHaveLength(1);
        const other = mint({ sub: 'someone-else' });
        expect(memosOf((await callRs(stack, { token: other })).json)).toEqual(
            [],
        );
    });
});

describe('M1-RS メモの持ち主', () => {
    it('別の人のメモは、一覧に出ない。読む、書き換える、消すは、403。メモは、そのまま', async () => {
        const alice = mint({ sub: `alice-${randomUUID()}` });
        const bob = mint({ sub: `bob-${randomUUID()}` });
        const created = await callRs(stack, {
            token: alice,
            method: 'POST',
            json: { body: "alice's memo" },
        });
        const { id } = created.json as MemoJson;

        const list = await callRs(stack, { token: bob });
        const read = await callRs(stack, { token: bob, path: `/memos/${id}` });
        const put = await callRs(stack, {
            token: bob,
            method: 'PUT',
            path: `/memos/${id}`,
            json: { body: 'hijacked' },
        });
        const del = await callRs(stack, {
            token: bob,
            method: 'DELETE',
            path: `/memos/${id}`,
        });

        expect(memosOf(list.json)).toEqual([]);
        expect([read.status, put.status, del.status]).toEqual([403, 403, 403]);
        const still = await callRs(stack, {
            token: alice,
            path: `/memos/${id}`,
        });
        expect(still.json).toMatchObject({ id, body: "alice's memo" });
    });

    it('無い id は、404', async () => {
        const token = mint();

        const read = await callRs(stack, {
            token,
            path: `/memos/${randomUUID()}`,
        });
        const put = await callRs(stack, {
            token,
            method: 'PUT',
            path: `/memos/${randomUUID()}`,
            json: { body: 'x' },
        });
        const del = await callRs(stack, {
            token,
            method: 'DELETE',
            path: `/memos/${randomUUID()}`,
        });

        expect([read.status, put.status, del.status]).toEqual([404, 404, 404]);
    });

    it('SQL の注入を試す id でも、404 で、メモは無事(SQLite)', async () => {
        const token = mint();
        await callRs(stack, { token, method: 'POST', json: { body: 'safe' } });
        const attacks = ["' OR '1'='1", "x'; DROP TABLE memos; --", '%', '_'];

        for (const attack of attacks) {
            const response = await callRs(stack, {
                token,
                path: `/memos/${encodeURIComponent(attack)}`,
            });
            expect(response.status).toBe(404);
        }

        expect(memosOf((await callRs(stack, { token })).json)).toHaveLength(1);
    });
});
