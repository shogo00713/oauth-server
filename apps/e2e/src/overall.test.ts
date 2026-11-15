/**
 * M1 の完了条件: 全体(docs/milestones/m1.md の「全体」)
 *   - OAuth 認可コードグラントの基本的なフロー
 *   - メモアプリ(RS)の CRUD
 * 本物の AS、RS、client を起動して、ブラウザの代わりに、通しで動かす
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    Browser,
    csrfOf,
    errorMessageOf,
    flashOf,
    memosOnPage,
} from './helpers/browser.js';
import { mintAccessToken } from './helpers/jwt.js';
import {
    callRs,
    loginThroughClient,
    obtainToken,
    type MemoJson,
} from './helpers/oauth.js';
import { startStack, type Stack } from './helpers/stack.js';

let stack: Stack;

beforeAll(async () => {
    stack = await startStack();
});

afterAll(async () => {
    await stack.stop();
});

describe('M1-OVERALL 認可コードグラントの、一周', () => {
    it('ログイン前は、メモが見えない。ログインを促す画面が出る', async () => {
        const browser = new Browser();

        const page = await browser.get(`${stack.client.baseUrl}/`);

        expect(page.status).toBe(200);
        expect(page.text).toContain('ログインして始める');
        expect(page.text).not.toContain('メモ一覧');
    });

    it('client の「ログイン」から、AS のログイン、同意を通って、client のメモ一覧に戻る', async () => {
        const browser = new Browser();
        const { client, as } = stack;

        // 1. ログインを始める → AS のログイン画面まで(リダイレクトを、全部追う)
        const login = await browser.get(`${client.baseUrl}/login`);
        expect(login.chain.map((hop) => new URL(hop.url).pathname)).toEqual([
            '/login',
            '/authorize',
            '/login',
        ]);
        expect(login.chain.map((hop) => hop.status)).toEqual([303, 303, 200]);
        expect(login.url).toBe(`${as.baseUrl}/login`);
        expect(login.text).toContain('メモボード');

        // 2. ユーザー名とパスワード → 同意の画面
        const consent = await browser.send(`${as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(login.text),
                username: stack.username,
                password: stack.password,
            },
        });
        expect(consent.url).toBe(`${as.baseUrl}/consent`);
        expect(consent.text).toContain('メモボード');
        expect(consent.text).toContain('<code>read</code>');
        expect(consent.text).toContain('<code>write</code>');

        // 3. 許可 → AS から client の /callback へ → トークンの引き換え → メモ一覧
        const home = await browser.send(`${as.baseUrl}/consent`, {
            form: { _csrf: csrfOf(consent.text), decision: 'allow' },
        });
        expect(home.chain.map((hop) => new URL(hop.url).pathname)).toEqual([
            '/consent',
            '/callback',
            '/',
        ]);
        expect(home.url).toBe(`${client.baseUrl}/`);
        expect(home.status).toBe(200);
        expect(home.text).toContain('メモ一覧');
        expect(flashOf(home.text)).toBe('ログインしました');
    });

    it('同意を拒否すると、client に戻って、ログインは成り立たない', async () => {
        const browser = new Browser();
        const { client, as } = stack;
        const login = await browser.get(`${client.baseUrl}/login`);
        const consent = await browser.send(`${as.baseUrl}/login`, {
            form: {
                _csrf: csrfOf(login.text),
                username: stack.username,
                password: stack.password,
            },
        });

        const home = await browser.send(`${as.baseUrl}/consent`, {
            form: { _csrf: csrfOf(consent.text), decision: 'deny' },
        });

        expect(home.url).toBe(`${client.baseUrl}/`);
        expect(flashOf(home.text)).toBe(
            'ログインを中止しました(アプリに許可が出されませんでした)',
        );
        expect(home.text).toContain('ログインして始める');
        expect(home.text).not.toContain('メモ一覧');
    });

    it('ブラウザには、アクセストークンも、client の秘密も、渡らない', async () => {
        const browser = new Browser();

        await loginThroughClient(stack, browser);
        const home = await browser.get(`${stack.client.baseUrl}/`);
        await browser.send(`${stack.client.baseUrl}/`, {
            form: { _csrf: csrfOf(home.text), body: 'secret-check' },
        });

        // 通った全てのレスポンス(ヘッダーも、本文も)を調べる
        const everything = browser.history
            .map(
                (seen) =>
                    `${seen.url}\n${[...seen.headers].join('\n')}\n${seen.text}`,
            )
            .join('\n');
        expect(everything).not.toContain(stack.clientSecret);
        expect(everything).not.toContain(stack.password);
        // JWT は、ヘッダーも本文も、base64url の「{"」(eyJ)で始まる
        expect(everything).not.toMatch(/eyJ[\w-]{5,}\.eyJ/);
    });
});

describe('M1-OVERALL メモの CRUD(client の画面から)', () => {
    it('作る、読む、書き換える、探す、消す', async () => {
        const browser = new Browser();
        const { client } = stack;
        await loginThroughClient(stack, browser);
        const marker = `overall-${randomUUID()}`;

        // 作る(複数行。ブラウザは、改行を CRLF で送る)
        const list = await browser.get(`${client.baseUrl}/`);
        const created = await browser.send(`${client.baseUrl}/`, {
            form: {
                _csrf: csrfOf(list.text),
                body: `${marker}\r\n2 行目`,
            },
        });
        expect(created.url).toBe(`${client.baseUrl}/`);
        expect(flashOf(created.text)).toBe('メモを追加しました');
        const found = memosOnPage(created.text).filter((memo) =>
            memo.body.includes(marker),
        );
        expect(found).toHaveLength(1);
        const id = found[0]?.id ?? '';
        // 改行は、LF にそろえて、保存される
        expect(found[0]?.body).toBe(`${marker}\n2 行目`);

        // 読む
        const detail = await browser.get(`${client.baseUrl}/detail/${id}`);
        expect(detail.status).toBe(200);
        expect(detail.text).toContain(marker);

        // 書き換える
        const saved = await browser.send(`${client.baseUrl}/detail/${id}`, {
            form: {
                _csrf: csrfOf(detail.text),
                action: 'update',
                body: `${marker} 書き換えた`,
            },
        });
        expect(saved.url).toBe(`${client.baseUrl}/detail/${id}`);
        expect(flashOf(saved.text)).toBe('メモを保存しました');
        expect(saved.text).toContain('書き換えた');

        // 探す(キーワード)
        const hit = await browser.get(
            `${client.baseUrl}/?q=${encodeURIComponent(marker)}`,
        );
        expect(memosOnPage(hit.text).map((memo) => memo.body)).toEqual([
            `${marker} 書き換えた`,
        ]);
        const miss = await browser.get(
            `${client.baseUrl}/?q=${encodeURIComponent(`${marker}-nothing`)}`,
        );
        expect(memosOnPage(miss.text)).toEqual([]);

        // 消す
        const deleted = await browser.send(`${client.baseUrl}/detail/${id}`, {
            form: { _csrf: csrfOf(saved.text), action: 'delete' },
        });
        expect(deleted.url).toBe(`${client.baseUrl}/`);
        expect(flashOf(deleted.text)).toBe('メモを削除しました');
        expect(memosOnPage(deleted.text).some((memo) => memo.id === id)).toBe(
            false,
        );
        const gone = await browser.get(`${client.baseUrl}/detail/${id}`);
        expect(gone.status).toBe(404);
        expect(errorMessageOf(gone.text)).toBeDefined();
    });

    it('メモは、持ち主ごとに別。別の人のメモには、触れない', async () => {
        const mine = new Browser();
        await loginThroughClient(stack, mine);
        const marker = `private-${randomUUID()}`;
        const list = await mine.get(`${stack.client.baseUrl}/`);
        const created = await mine.send(`${stack.client.baseUrl}/`, {
            form: { _csrf: csrfOf(list.text), body: marker },
        });
        const id =
            memosOnPage(created.text).find((memo) => memo.body === marker)
                ?.id ?? '';

        // 別の人(トークンの sub が違う)から見ると、一覧に無くて、読めない
        const { token } = otherUser();
        const theirList = await callRs(stack, { token });
        const theirRead = await callRs(stack, { token, path: `/memos/${id}` });

        expect(theirList.status).toBe(200);
        expect((theirList.json as { memos: MemoJson[] }).memos).toEqual([]);
        expect(theirRead.status).toBe(403);
    });
});

describe('M1-OVERALL メモの CRUD(RS の API を、直接)', () => {
    it('作る(201 と Location)、読む、書き換える、消す(204)、消えている(404)', async () => {
        const { accessToken: token } = await obtainToken(stack);
        const marker = `api-${randomUUID()}`;

        const created = await callRs(stack, {
            token,
            method: 'POST',
            json: { body: marker },
        });
        expect(created.status).toBe(201);
        const memo = created.json as MemoJson;
        expect(Object.keys(memo).sort()).toEqual([
            'body',
            'createdAt',
            'id',
            'updatedAt',
        ]);
        expect(memo.body).toBe(marker);
        expect(memo.updatedAt).toBe(memo.createdAt);
        expect(created.headers.get('location')).toBe(`/memos/${memo.id}`);

        const read = await callRs(stack, { token, path: `/memos/${memo.id}` });
        expect(read.status).toBe(200);
        expect(read.json).toEqual(memo);

        const listed = await callRs(stack, { token });
        expect(
            (listed.json as { memos: MemoJson[] }).memos.map((m) => m.id),
        ).toContain(memo.id);

        const updated = await callRs(stack, {
            token,
            method: 'PUT',
            path: `/memos/${memo.id}`,
            json: { body: `${marker} 2` },
        });
        expect(updated.status).toBe(200);
        expect(updated.json).toMatchObject({
            id: memo.id,
            body: `${marker} 2`,
            createdAt: memo.createdAt,
        });

        const deleted = await callRs(stack, {
            token,
            method: 'DELETE',
            path: `/memos/${memo.id}`,
        });
        expect(deleted.status).toBe(204);
        expect(deleted.text).toBe('');

        const gone = await callRs(stack, { token, path: `/memos/${memo.id}` });
        expect(gone.status).toBe(404);
    });
});

describe('M1-OVERALL RS を止めて、立て直しても、メモが残る(SQLite)', () => {
    it('SIGTERM で、きれいに終わって(終了コード 0)、立て直したあとも、メモも持ち主も、そのまま', async () => {
        const browser = new Browser();
        await loginThroughClient(stack, browser);
        const marker = `persist-${randomUUID()}`;
        const list = await browser.get(`${stack.client.baseUrl}/`);
        await browser.send(`${stack.client.baseUrl}/`, {
            form: { _csrf: csrfOf(list.text), body: marker },
        });
        const { accessToken: token } = await obtainToken(stack);
        const before = (
            (await callRs(stack, { token })).json as { memos: MemoJson[] }
        ).memos.find((memo) => memo.body === marker);
        expect(before).toBeDefined();

        const exit = await stack.restartRs('SIGTERM');

        expect(exit).toEqual({ code: 0, signal: null });
        // 立て直したあと: 同じ id、同じ日時で、残っている(client の画面にも、API にも)
        const after = (
            (await callRs(stack, { token })).json as { memos: MemoJson[] }
        ).memos.find((memo) => memo.body === marker);
        expect(after).toEqual(before);
        const home = await browser.get(`${stack.client.baseUrl}/`);
        expect(memosOnPage(home.text).map((memo) => memo.body)).toContain(
            marker,
        );
    });
});

// 別の人のトークン(AS が出した物ではなく、AS の鍵で署名した、sub の違う物)
const otherUser = () => ({
    token: mintAccessToken({
        privateKeyPem: stack.privateKeyPem,
        issuer: stack.issuer,
        audience: stack.audience,
        sub: `other-${randomUUID()}`,
        scope: 'read write',
    }),
});
