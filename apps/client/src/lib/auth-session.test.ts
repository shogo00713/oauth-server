import { describe, expect, it } from 'vitest';
import type { TokenSet } from '../oauth/token-request.js';
import { currentTokens, TOKEN_LEEWAY_SEC } from './auth-session.js';

const NOW = 1_800_000_000;

const tokens = (expiresAt: number | undefined): TokenSet => ({
    accessToken: 'at-1',
    expiresAt,
    scope: 'read write',
});

describe('AUTH SESSION ログインの状態', () => {
    describe('TOKEN_LEEWAY_SEC', () => {
        it('期限の 30 秒前から、期限切れとして扱う', () => {
            expect(TOKEN_LEEWAY_SEC).toBe(30);
        });
    });

    describe('currentTokens', () => {
        it('トークンが無ければ、undefined', () => {
            expect(currentTokens({}, NOW)).toBeUndefined();
            expect(currentTokens({ tokens: undefined }, NOW)).toBeUndefined();
        });

        it('期限が分からないトークンは、使える物として返す', () => {
            const session = { tokens: tokens(undefined) };

            expect(currentTokens(session, NOW)).toBe(session.tokens);
        });

        it('期限が十分先なら、そのトークンを返す(同じ物)', () => {
            const session = { tokens: tokens(NOW + 3600) };

            expect(currentTokens(session, NOW)).toBe(session.tokens);
        });

        it.each([
            { name: '期限の 31 秒前', expiresAt: NOW + 31, usable: true },
            {
                name: '期限の 30 秒前(ちょうど)',
                expiresAt: NOW + 30,
                usable: false,
            },
            { name: '期限の 29 秒前', expiresAt: NOW + 29, usable: false },
            { name: '期限の 1 秒前', expiresAt: NOW + 1, usable: false },
            { name: '期限ちょうど', expiresAt: NOW, usable: false },
            { name: '期限の 1 秒後', expiresAt: NOW - 1, usable: false },
            { name: '期限を、ずっと過ぎた', expiresAt: 1000, usable: false },
        ])('$name: 使える=$usable', ({ expiresAt, usable }) => {
            const session = { tokens: tokens(expiresAt) };

            expect(currentTokens(session, NOW)).toBe(
                usable ? session.tokens : undefined,
            );
        });

        it('今の時刻が進めば、使えなくなる', () => {
            const session = { tokens: tokens(NOW + 100) };

            expect(currentTokens(session, NOW)).toBe(session.tokens);
            expect(currentTokens(session, NOW + 69)).toBe(session.tokens);
            expect(currentTokens(session, NOW + 70)).toBeUndefined();
        });

        it('期限切れでも、セッションは書き換えない(トークンを消さない)', () => {
            const expired = tokens(NOW - 100);
            const session = { tokens: expired };

            currentTokens(session, NOW);

            expect(session.tokens).toBe(expired);
            expect(session.tokens).toEqual(tokens(NOW - 100));
        });

        it('返すトークンは、中身に触らない', () => {
            const session = { tokens: tokens(NOW + 3600) };
            const result = currentTokens(session, NOW);

            expect(result).toEqual({
                accessToken: 'at-1',
                expiresAt: NOW + 3600,
                scope: 'read write',
            });
        });
    });
});
