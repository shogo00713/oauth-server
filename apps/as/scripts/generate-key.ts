/**
 * AS の署名用の鍵（RSA, 2048 bit）を作るスクリプト
 *
 * 使い方: pnpm --filter @oauth/as gen:key
 *
 * 出来上がる鍵と置き場
 * - keys/as-private.pem : 秘密鍵, AS だけが持つ
 * - keys/as-public.pem  : 公開鍵, RS に渡す
 */

import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const keysDir = fileURLToPath(new URL('../../../keys/', import.meta.url));
const privatePath = `${keysDir}as-private.pem`;
const publicPath = `${keysDir}as-public.pem`;

const existing = [privatePath, publicPath].filter((path) => existsSync(path));

if (existing.length > 0) {
    console.error('--------------------------------');
    console.error('鍵が次の場所に既に存在したので、何も行っていません');
    for (const path of existing) console.error(`  ${path}`);
    console.error(
        '鍵を作り直したい場合は、既存の鍵を削除してから、再度このスクリプトを実行してください',
    );
    console.error('--------------------------------');
    process.exit(1); // 強制終了
}

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
});

mkdirSync(keysDir, { recursive: true });
writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
writeFileSync(publicPath, publicKey, { mode: 0o644, flag: 'wx' });

console.log('--------------------------------');
console.log('以下の場所に鍵を作成しました');
console.log(`  秘密鍵（AS用）: ${privatePath}`);
console.log(`  公開鍵（RS用）: ${publicPath}`);
console.log('--------------------------------');
