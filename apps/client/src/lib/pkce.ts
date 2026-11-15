/**
 * PKCE(RFC 7636)の、client 側の処理
 *   S256: code_challenge = BASE64URL(SHA256(ASCII(code_verifier)))
 *   RFC 9700 2.1.1: confidential client も、PKCE を使う(S256)
 */

import crypto from 'node:crypto';
import { generateRandomString } from './random.js';

/**
 * code_verifier から code_challenge を計算する
 * (code_verifier の形は、検査しない。作るのは createPkcePair)
 */
export function computeCodeChallenge(codeVerifier: string): string {
    const ascii_code_verifier = Buffer.from(codeVerifier, 'ascii');
    const bytes_code_challenge = crypto
        .createHash('sha256')
        .update(ascii_code_verifier);
    return bytes_code_challenge.digest('base64url');
}

export type PkcePair = {
    codeVerifier: string;
    codeChallenge: string;
};

/**
 * ログインの 1 回ごとに、新しい code_verifier(43 文字)と、その code_challenge を作る
 */
export function createPkcePair(): PkcePair {
    const codeVerifier = generateRandomString();
    const codeChallenge = computeCodeChallenge(codeVerifier);
    return {
        codeVerifier: codeVerifier,
        codeChallenge: codeChallenge,
    };
}
