/**
 * 認可サーバー（AS）を起動だけを行うスクリプト
 *
 * 使い方: pnpm --filter @oauth/as dev
 *
 * 環境変数や鍵の読み取りは、bootstrap() 内で行う
 * その後のアプリの起動は、createApp() 内で行う
 */

import { bootstrap } from './bootstrap.js';

try {
    const { app, config } = await bootstrap(process.env);

    app.listen(config.port, (error) => {
        if (error) {
            console.error('--------------------------------');
            console.error(
                `認可サーバーを起動できませんでした: ${error.message}`,
            );
            console.error('--------------------------------');
            process.exit(1);
        }
        console.log('--------------------------------');
        console.log(`認可サーバーを起動しました`);
        console.log('--------------------------------');
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
