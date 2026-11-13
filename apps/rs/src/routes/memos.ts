/**
 * メモの CRUD(docs/design/rs.md の「ルーティング」「各 API」)
 *   GET    /memos      一覧(read または write)
 *   GET    /memos/:id  1 件(read または write)
 *   POST   /memos      作成(write)
 *   PUT    /memos/:id  更新(write)
 *   DELETE /memos/:id  削除(write)
 *
 * このルーターは、authenticate(アクセストークンの検証)が済んでいる前提で使う
 *   app.use('/memos', authenticate(...), createMemosRouter(...))
 */
import express, { type Request, type Response, type Router } from 'express';
import { MAX_BODY_LENGTH, parseMemoInput } from '../lib/memo-input.js';
import { toMemoResponse } from '../lib/memo-response.js';
import { noStore } from '../middleware/no-store.js';
import { requireScope } from '../middleware/require-scope.js';
import type { Memo, MemoStore } from '../stores/memo-store.js';

export type MemosRouterDeps = {
    memoStore: MemoStore;
    // WWW-Authenticate の realm
    realm: string;
};

// 受け付けるスコープ(弱い方を先頭に)
const READ_SCOPES = ['read', 'write'];
const WRITE_SCOPES = ['write'];

const INVALID_BODY_MESSAGE = `body must be a string of 1 to ${MAX_BODY_LENGTH} characters`;

export function createMemosRouter(deps: MemosRouterDeps): Router {
    const { memoStore, realm } = deps;
    const router = express.Router();
    const jsonBody = express.json({ limit: '100kb' });

    // authenticate の後ろで、持ち主(トークンの sub)
    const ownerOf = (req: Request): string => {
        const sub = req.auth?.sub;
        if (!sub)
            throw new Error(
                'req.auth がありません(authenticate の後ろに置いてください)',
            );
        return sub;
    };

    // メモを探して、持ち主を確かめる。使えない時は、返事を送って null を返す
    const findOwned = async (
        req: Request,
        res: Response,
    ): Promise<Memo | null> => {
        // 型は string | string[] だが、この道の :id は、必ず string
        const id = req.params['id'];
        const memo = typeof id === 'string' ? await memoStore.find(id) : null;
        if (!memo) {
            res.status(404).json({ error: 'not_found' });
            return null;
        }
        if (memo.owner !== ownerOf(req)) {
            res.status(403).json({ error: 'forbidden' });
            return null;
        }
        return memo;
    };

    // 返事を、キャッシュさせない
    router.use(noStore);

    router.get('/', requireScope(realm, READ_SCOPES), async (req, res) => {
        const memos = await memoStore.listByOwner(ownerOf(req));
        res.json({ memos: memos.map(toMemoResponse) });
    });

    router.post(
        '/',
        requireScope(realm, WRITE_SCOPES),
        jsonBody,
        async (req, res) => {
            const input = parseMemoInput(req.body);
            if (!input) {
                res.status(400).json({
                    error: 'invalid_request',
                    error_description: INVALID_BODY_MESSAGE,
                });
                return;
            }

            const memo = await memoStore.create({
                owner: ownerOf(req),
                body: input.body,
            });
            res.status(201)
                .location(`${req.baseUrl}/${encodeURIComponent(memo.id)}`)
                .json(toMemoResponse(memo));
        },
    );

    router.get('/:id', requireScope(realm, READ_SCOPES), async (req, res) => {
        const memo = await findOwned(req, res);
        if (!memo) return;
        res.json(toMemoResponse(memo));
    });

    router.put(
        '/:id',
        requireScope(realm, WRITE_SCOPES),
        jsonBody,
        async (req, res) => {
            // 入力の検証が先(docs/design/rs.md: 検証、取得、404 か 403 の判定、更新)
            const input = parseMemoInput(req.body);
            if (!input) {
                res.status(400).json({
                    error: 'invalid_request',
                    error_description: INVALID_BODY_MESSAGE,
                });
                return;
            }

            const memo = await findOwned(req, res);
            if (!memo) return;

            const updated = await memoStore.update(memo.id, input.body);
            if (!updated) {
                // 探してから更新するまでの間に、消された
                res.status(404).json({ error: 'not_found' });
                return;
            }
            res.json(toMemoResponse(updated));
        },
    );

    router.delete(
        '/:id',
        requireScope(realm, WRITE_SCOPES),
        async (req, res) => {
            const memo = await findOwned(req, res);
            if (!memo) return;

            await memoStore.delete(memo.id);
            res.status(204).end();
        },
    );

    // 上の組み合わせ以外のメソッド(RFC 9110 15.5.6: 405 には、Allow が要る)
    router.all('/', (_req, res) => {
        res.status(405)
            .set('Allow', 'GET, POST')
            .json({ error: 'method_not_allowed' });
    });
    router.all('/:id', (_req, res) => {
        res.status(405)
            .set('Allow', 'GET, PUT, DELETE')
            .json({ error: 'method_not_allowed' });
    });

    return router;
}
