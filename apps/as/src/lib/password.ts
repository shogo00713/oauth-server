import argon2 from 'argon2';

export type Argon2Costs = {
    // メモリの量(KiB)
    memoryCost: number;
    // 繰り返す回数
    timeCost: number;
    // 並列の数
    parallelism: number;
};

export async function hashPassword(
    password: string,
    costs?: Argon2Costs,
): Promise<string> {
    if (typeof password !== 'string') {
        throw new TypeError('designate password!');
    }
    if (!password) {
        throw new RangeError('designate password!');
    }

    const hash = await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: costs?.memoryCost ?? 65536,
        timeCost: costs?.timeCost ?? 3,
        parallelism: costs?.parallelism ?? 4,
    });

    return hash;
}

export async function verifyPassword(
    password: unknown,
    hash: unknown,
): Promise<boolean> {
    if (typeof password !== 'string' || typeof hash !== 'string') {
        return false;
    }

    try {
        return await argon2.verify(hash, password);
    } catch {
        return false;
    }
}
