import { describe, expect, it } from 'vitest';
import { computeCodeChallenge, createPkcePair } from './pkce.js';

// RFC 7636 付録 B の組
const APPENDIX_B_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const APPENDIX_B_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

describe('PKCE client 側の処理 RFC 7636', () => {
    describe('computeCodeChallenge', () => {
        it('RFC 7636 付録 B の組と、一致する', () => {
            expect(computeCodeChallenge(APPENDIX_B_VERIFIER)).toBe(
                APPENDIX_B_CHALLENGE,
            );
        });

        it('43 文字の base64url(パディングなし、+ / = を含まない)', () => {
            const challenge = computeCodeChallenge('a'.repeat(43));

            expect(challenge).toHaveLength(43);
            expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
        });

        it('同じ入力なら、同じ結果。違う入力なら、違う結果', () => {
            expect(computeCodeChallenge('a'.repeat(43))).toBe(
                computeCodeChallenge('a'.repeat(43)),
            );
            expect(computeCodeChallenge('a'.repeat(43))).not.toBe(
                computeCodeChallenge('a'.repeat(42) + 'b'),
            );
        });

        it('128 文字の code_verifier でも、43 文字になる', () => {
            expect(computeCodeChallenge('a'.repeat(128))).toHaveLength(43);
        });
    });

    describe('createPkcePair', () => {
        it('code_verifier は、43 文字で、使える文字(A-Z a-z 0-9 - . _ ~)だけ', () => {
            const { codeVerifier } = createPkcePair();

            expect(codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43}$/);
        });

        it('code_challenge は、その code_verifier から計算した物', () => {
            const { codeVerifier, codeChallenge } = createPkcePair();

            expect(codeChallenge).toBe(computeCodeChallenge(codeVerifier));
        });

        it('呼ぶたびに、別の組になる(1000 回、全部違う)', () => {
            const verifiers = Array.from(
                { length: 1000 },
                () => createPkcePair().codeVerifier,
            );

            expect(new Set(verifiers).size).toBe(1000);
        });

        it('code_challenge に、code_verifier は、含まれない', () => {
            const { codeVerifier, codeChallenge } = createPkcePair();

            expect(codeChallenge).not.toContain(codeVerifier);
            expect(codeChallenge).not.toBe(codeVerifier);
        });
    });
});
