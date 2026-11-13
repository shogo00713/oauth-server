import type { RequestHandler } from 'express';

// 返事を、キャッシュさせない(メモは、その人だけの情報)
export const noStore: RequestHandler = (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
};
