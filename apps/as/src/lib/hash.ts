import crypto from 'node:crypto';

export function sha256Hex(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf-8').digest('hex');
}

export function verifySecret(secret: unknown, expectedHash: unknown): boolean {
    if (typeof secret !== 'string' || typeof expectedHash !== 'string')
        return false;
    if (secret === '') return false;
    const hash = sha256Hex(secret);
    return (
        hash.length === expectedHash.length &&
        crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash))
    );
}
