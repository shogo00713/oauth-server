/**
 * クライアント認証に関わる機能を実装した関数
 */

export function decodeFormUrlencoded(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch {
        return null;
    }
}

export function parseClientCredentials(
    header: unknown,
): { clientId: string; clientSecret: string } | null {
    if (typeof header !== 'string') return null;

    const match = header.match(/^Basic\s+(\S+)$/i);
    if (!match) return null;

    const token = match?.[1];
    if (!token) return null;

    // Base64デコード
    const bytes = Buffer.from(token, 'base64');
    if (bytes.toString('base64') !== token) return null;

    let decoded: string;
    try {
        decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return null;
    }

    // 最初のコロンで分割
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return null;

    const encodedClientId = decoded.slice(0, separatorIndex);
    const encodedClientSecret = decoded.slice(separatorIndex + 1);

    const clientId = decodeFormUrlencoded(encodedClientId);
    const clientSecret = decodeFormUrlencoded(encodedClientSecret);

    if (!clientId || !clientSecret) return null;

    const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
    if (CONTROL_CHARS.test(clientId) || CONTROL_CHARS.test(clientSecret))
        return null;

    return { clientId, clientSecret };
}
