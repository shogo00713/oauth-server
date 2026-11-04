/**
 * AS の署名用の鍵 (RSA 2048 bit) を作るスクリプト
 *
 * 使い方: pnpm --filter @oauth/as gen:key
 *
 * 作る物(リポジトリ直下の keys/ )
 * - keys/as-private.pem : 秘密鍵(PKCS#8 の PEM) AS だけが持つ
 * - keys/as-public.pem  : 公開鍵(SPKI の PEM) RS に渡す
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const keysDir = fileURLToPath(new URL('../../../keys/', import.meta.url));
const privatePath = `${keysDir}as-private.pem`;
const publicPath = `${keysDir}as-public.pem`;

const existing = [privatePath, publicPath].filter((path) => existsSync(path));
if (existing.length > 0) {
    console.error('鍵がすでにあるので、何もしませんでした:');
    for (const path of existing) console.error(`  ${path}`);
    console.error(
        '作り直す時は、上のファイルを自分で消してから、もう一度実行してください。',
    );
    process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

mkdirSync(keysDir, { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(publicPath, publicKey, { mode: 0o644, flag: 'wx' });

console.log('鍵を作りました:');
console.log(`  秘密鍵(AS 用): ${privatePath}`);
console.log(`  公開鍵(RS 用): ${publicPath}`);
