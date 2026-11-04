import { createPublicKey } from 'node:crypto';
import { calculateJwkThumbprint, importPKCS8, importSPKI } from 'jose';

export type SigningKey = {
    privateKey: CryptoKey;
    publicKey: CryptoKey;
    kid: string;
};

const MIN_MODULUS_LENGTH = 2048;

export async function importSigningKey(
    privatePem: string,
): Promise<SigningKey> {
    const privateKey = await importPKCS8(privatePem, 'RS256');

    const publicKeyObject = createPublicKey(privatePem);
    const modulusLength =
        publicKeyObject.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modulusLength < MIN_MODULUS_LENGTH)
        throw new RangeError('RSA の鍵は 2048 bit 以上にしてください');

    const publicPem = publicKeyObject
        .export({ type: 'spki', format: 'pem' })
        .toString();
    const publicKey = await importSPKI(publicPem, 'RS256');
    const kid = await calculateJwkThumbprint(publicKey);

    return { privateKey, publicKey, kid };
}
