import type { ErrorRequestHandler, RequestHandler, Response } from 'express';

// エラー画面(views/error.ejs)を、指定した status で返す
export function sendErrorPage(
    res: Response,
    status: number,
    message: string,
): void {
    res.status(status).render('error', {
        status,
        message,
    });
}

// ルートが無い時
export const notFoundHandler: RequestHandler = (_req, res) => {
    sendErrorPage(res, 404, 'ページが見つかりません');
};

// 例外から、status(数字)を取り出す。無ければ null
const statusOf = (error: unknown): number | null =>
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
        ? error.status
        : null;

// 例外が起きた時。中身(メッセージやスタック)は、画面に出さない
export const pageErrorHandler: ErrorRequestHandler = (
    error,
    _req,
    res,
    _next,
) => {
    const status = statusOf(error);
    if (status !== null && status >= 400 && status < 500) {
        return sendErrorPage(res, status, 'リクエストが正しくありません');
    }
    console.error(error);
    sendErrorPage(res, 500, 'サーバー内部でエラーが発生しました');
};
