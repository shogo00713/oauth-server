import { importSPKI } from 'jose';

const MIN_MODULUS_LENGTH = 2048;

export async function importVerifyKey(publicPem: string): Promise<CryptoKey> {
    // 前後の空白や改行があっても読めるようにする
    const key = await importSPKI(publicPem.trim(), 'RS256');

    const { modulusLength } = key.algorithm as RsaHashedKeyAlgorithm;
    if (modulusLength < MIN_MODULUS_LENGTH)
        throw new RangeError('RSA の鍵は 2048 bit 以上にしてください');

    return key;
}
