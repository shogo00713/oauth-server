import { bootstrap } from './bootstrap.js';

try {
    const { app, config } = bootstrap(process.env);

    app.listen(config.port, (error) => {
        if (error) {
            console.error(`起動できませんでした: ${error.message}`);
            process.exit(1);
        }
        console.log(
            `メモボード(client)を起動しました: ${config.baseUrl} (port ${config.port})`,
        );
    });
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
}
