import type { ErrorRequestHandler, RequestHandler } from 'express';

// ルートが無い時
export const notFoundHandler: RequestHandler = (_req, res) => {
    res.status(404).json({ error: 'not_found' });
};

// 例外から、status(数字)を取り出す。無ければ null
const statusOf = (error: unknown): number | null =>
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
        ? error.status
        : null;

// 例外が起きた時。中身(メッセージやスタック)は、返事に出さない
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = statusOf(error);
    // body-parser の「JSON が壊れている(400)」「大きすぎる(413)」など、クライアントの間違い
    if (status !== null && status >= 400 && status < 500) {
        res.status(status).json({ error: 'invalid_request' });
        return;
    }
    console.error(error);
    res.status(500).json({ error: 'server_error' });
};
