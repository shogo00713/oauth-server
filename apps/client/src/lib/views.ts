import type { Express } from 'express';
import { fileURLToPath } from 'node:url';

// ejs の画面を置いてある場所(apps/as/src/views)
export const VIEWS_DIR = fileURLToPath(new URL('../views', import.meta.url));

// 画面のエンジンを ejs にして、置き場所を教える
export function configureViews(app: Express): void {
    app.set('view engine', 'ejs');
    app.set('views', VIEWS_DIR);
}
