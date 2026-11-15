import type { Request } from 'express';

/**
 * セッションを捨てて、新しい空のセッションにする(ログアウト、期限切れ、再ログインの時)
 *   セッション ID が変わって、古いセッション(トークンも)は、ストアから消える
 *   flash を渡せば、新しいセッションに入れる(次の画面で、1 回だけ出る)
 */
export function resetSession(req: Request, flash?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        req.session.regenerate((error) => {
            if (error) return reject(error);
            if (flash !== undefined) req.session.flash = flash;
            resolve();
        });
    });
}
