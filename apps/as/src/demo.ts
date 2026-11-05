/**
 * 動作確認用(デモ専用): AS を起動して、認可コードを 1 つ、ストアに入れておく
 *
 * /authorize がまだ無いので、curl で /token を叩くための認可コードを、ここで用意する。
 * 使い方: pnpm --filter @oauth/as demo
 * 画面に出る curl のコマンドを、別のターミナルで実行する(コードは 1 回きり)
 */
import { bootstrap } from './bootstrap.js';
import { loadClientsFromEnv } from './clients-from-env.js';
import { sha256Hex } from './lib/hash.js';
import { computeCodeChallenge } from './lib/pkce.js';
import { generateRandomString } from './lib/random.js';

const DEMO_CODE_TTL_SEC = 60;

try {
    const { app, config, codeStore } = await bootstrap(process.env);
    const [client] = loadClientsFromEnv(process.env);
    const redirectUri = client?.redirectUris[0];
    if (!client || !redirectUri) throw new Error('クライアントがありません');

    // デモ用の認可コードと、PKCE の code_verifier
    const code = generateRandomString();
    const codeVerifier = generateRandomString();
    await codeStore.save(sha256Hex(code), {
        clientId: client.clientId,
        redirectUri,
        codeChallenge: computeCodeChallenge(codeVerifier),
        sub: 'demo-user',
        scope: config.defaultScope,
        expiresAt: Math.floor(Date.now() / 1000) + DEMO_CODE_TTL_SEC,
    });

    app.listen(config.port, (error) => {
        if (error) {
            console.error(`起動できませんでした: ${error.message}`);
            process.exit(1);
        }
        console.log(`[デモ] 認可サーバーを起動しました: ${config.issuer}`);
        console.log(
            `[デモ] 認可コードを 1 つ用意しました(${DEMO_CODE_TTL_SEC} 秒の間、1 回だけ使えます)`,
        );
        console.log('[デモ] 別のターミナルで、これを実行してください:\n');
        console.log(
            [
                `curl -s -X POST ${config.issuer}/token`,
                `  -u '${client.clientId}:${process.env['CLIENT_SECRET']}'`,
                '  -d grant_type=authorization_code',
                `  -d code=${code}`,
                `  --data-urlencode redirect_uri=${redirectUri}`,
                `  -d code_verifier=${codeVerifier}`,
            ].join(' \\\n'),
        );
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
