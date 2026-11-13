import { generateRandomString } from './random.js';

export function generateCsrfToken(): string {
    return generateRandomString();
}

export function isValidCsrfToken(expected: unknown, actual: unknown): boolean {
    if (typeof expected !== 'string' || typeof actual !== 'string')
        return false;
    if (!expected || !actual) return false;
    if (expected === actual) return true;
    else return false;
}

export function ensureCsrfToken(session: {
    csrfToken?: string | undefined;
}): string {
    if (session.csrfToken && typeof session.csrfToken === 'string') {
        return session.csrfToken;
    } else {
        session.csrfToken = generateCsrfToken();
        return session.csrfToken;
    }
}
