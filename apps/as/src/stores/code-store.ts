export type AuthCodeRecord = {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    sub: string;
    scope: readonly string[];
    expiresAt: number;
};

export interface CodeStore {
    save(codeHash: string, record: AuthCodeRecord): Promise<void>;
    consume(codeHash: string, now?: number): Promise<AuthCodeRecord | null>;
}
