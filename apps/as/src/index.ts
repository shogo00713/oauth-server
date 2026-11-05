import { bootstrap } from './bootstrap.js';

try {
    const { app, config } = await bootstrap(process.env);

    app.listen(config.port, (error) => {
        if (error) {
            console.error(`起動できませんでした: ${error.message}`);
            process.exit(1);
        }
        console.log(
            `認可サーバーを起動しました: ${config.issuer} (port ${config.port})`,
        );
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
