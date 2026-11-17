import { bootstrap } from './bootstrap.js';

try {
    const { app, config, close } = await bootstrap(process.env);

    const server = app.listen(config.port, (error) => {
        if (error) {
            console.error(`起動できませんでした: ${error.message}`);
            process.exit(1);
        }
        console.log('--------------------------------');
        console.log(`リソースサーバーを起動しました`);
        console.log('--------------------------------');
    });

    // 止める時に、データベースを閉じる
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            server.close();
            close();
            process.exit(0);
        });
    }
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
