import { z } from 'zod';
import { sha256Hex } from './lib/hash.js';
import type { User } from './stores/user-store.js';
import { hashPassword } from './lib/password.js';

const emptyAsUnset = (value: unknown) => (value === '' ? undefined : value);

const schema = z.object({
    USER_NAME: z.preprocess(
        emptyAsUnset,
        z
            .string()
            .regex(/^[A-Za-z0-9_\-.~]{1,64}$/)
            .optional(),
    ),
    USER_PASSWORD: z.preprocess(emptyAsUnset, z.string().min(12)),
});

export async function loadUsersFromEnv(
    env: Record<string, string | undefined>,
): Promise<User[]> {
    const result = schema.safeParse(env);
    if (!result.success)
        throw new Error(
            `環境変数が不正です:\n${z.prettifyError(result.error)}`,
        );
    const values = result.data;
    const username = values.USER_NAME ?? 'demo';
    return [
        {
            id: sha256Hex('user' + username).slice(0, 32),
            username: username,
            passwordHash: await hashPassword(values.USER_PASSWORD),
        },
    ];
}
