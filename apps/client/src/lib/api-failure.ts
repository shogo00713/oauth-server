/**
 * RS を呼んで、失敗した時の、画面の動き(docs/design/client.md の表)
 *   401 → セッションを捨てて、再ログイン / 403 の insufficient_scope → 権限不足 / 403 のそれ以外 → 許可されていない
 *   404、5xx、通信の失敗 → エラー画面(リトライしない)
 */
import type { Request, Response } from 'express';
import type { ApiFailure } from '../rs/memo-api.js';
import { sendErrorPage } from './page-errors.js';
import { resetSession } from './session-reset.js';

export type FailureResponse =
    // セッションを捨てて、トップ(ログイン前の画面)へ
    { kind: 'relogin' } | { kind: 'page'; status: number; message: string };

// 画面に出す言葉
const MESSAGES = {
    relogin: 'ログインの有効期限が切れました。もう一度、ログインしてください',
    insufficientScope:
        '権限が足りません。このアプリに許可された操作では、できません',
    forbidden: 'このメモは、操作が許可されていません',
    notFound: 'メモが見つかりません',
    invalidRequest: 'リクエストが正しくありません',
    unavailable:
        'メモアプリと通信できませんでした。時間をおいて、もう一度試してください',
} as const;

export function describeApiFailure(failure: ApiFailure): FailureResponse {
    switch (failure) {
        case 'unauthorized':
            return { kind: 'relogin' };
        case 'insufficient_scope':
            return {
                kind: 'page',
                status: 403,
                message: MESSAGES.insufficientScope,
            };
        case 'forbidden':
            return { kind: 'page', status: 403, message: MESSAGES.forbidden };
        case 'not_found':
            return { kind: 'page', status: 404, message: MESSAGES.notFound };
        case 'invalid_request':
            return {
                kind: 'page',
                status: 400,
                message: MESSAGES.invalidRequest,
            };
        case 'unavailable':
            return {
                kind: 'page',
                status: 502,
                message: MESSAGES.unavailable,
            };
    }
}

/**
 * 失敗に合わせた返事を返す
 *   relogin: セッションを捨てて、/ へ 303(ログイン前の画面が出る。フォームの送信から、AS へ直接飛ばさない)
 */
export async function respondWithFailure(
    req: Request,
    res: Response,
    failure: ApiFailure,
): Promise<void> {
    const response = describeApiFailure(failure);
    if (response.kind === 'relogin') {
        await resetSession(req, MESSAGES.relogin);
        res.redirect(303, '/');
        return;
    }
    sendErrorPage(res, response.status, response.message);
}
