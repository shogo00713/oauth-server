import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { configureViews, VIEWS_DIR } from './views.js';

describe('VIEWS ejs の画面の置き場所', () => {
    describe('VIEWS_DIR', () => {
        it('絶対パスで、フォルダが実際にある', () => {
            expect(isAbsolute(VIEWS_DIR)).toBe(true);
            expect(statSync(VIEWS_DIR).isDirectory()).toBe(true);
        });

        it('フォルダの名前は views で、中に error.ejs がある', () => {
            expect(basename(VIEWS_DIR)).toBe('views');
            expect(existsSync(join(VIEWS_DIR, 'error.ejs'))).toBe(true);
        });
    });

    describe('configureViews', () => {
        it('画面のエンジンを ejs に、置き場所を VIEWS_DIR にする', () => {
            const app = express();

            configureViews(app);

            expect(app.get('view engine')).toBe('ejs');
            expect(app.get('views')).toBe(VIEWS_DIR);
        });

        it('設定した app で、error.ejs を描ける', async () => {
            const app = express();
            configureViews(app);

            const html = await new Promise<string>((resolve, reject) => {
                app.render(
                    'error',
                    { message: 'テスト用のメッセージ' },
                    (error, rendered) =>
                        error ? reject(error) : resolve(rendered),
                );
            });

            expect(html).toContain('<html');
            expect(html).toContain('テスト用のメッセージ');
        });
    });
});
