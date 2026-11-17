import { z } from 'zod';
import { sha256Hex } from './lib/hash.js';
import type { User } from './stores/user-store.js';
import { hashPassword } from './lib/password.js';

// ユーザー名に使用できる正規表現
const regexUsername = /^[A-Za-z0-9_\-.~]{1,64}$/;

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

// ユーザー名とパスワードの環境変数の検証
const schema = z.object({
    USER_NAME: z.preprocess(emptyAsUnset, z.string().regex(regexUsername)),
    USER_PASSWORD: z.preprocess(emptyAsUnset, z.string().min(12)),
});

/**
 * 環境変数から、登録済みユーザーの情報を読み込む関数
 *
 * zod でそれぞれ検証をしている
 *
 * @param env 環境変数全体, 特に必要なのは USER_NAME, USER_PASSWORD
 * @returns 登録済みユーザーの配列
 */
export async function loadUsersFromEnv(
    env: Record<string, string | undefined>,
): Promise<User[]> {
    const result = schema.safeParse(env);
    if (!result.success)
        throw new Error(
            `--------------------------------\n
環境変数が不正です:\n
${z.prettifyError(result.error)}\n
--------------------------------`,
        );
    const values = result.data;

    // ユーザーID, ユーザー名, パスワードハッシュを作る
    const username = values.USER_NAME;
    const id = sha256Hex('user' + username).slice(0, 32);
    const password = values.USER_PASSWORD;
    const passwordHash = await hashPassword(password);

    return [
        {
            id: id,
            username: username,
            passwordHash: passwordHash,
        },
    ];
}
