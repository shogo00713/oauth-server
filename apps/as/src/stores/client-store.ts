export type Client = {
    clientId: string;
    secretHash: string;
    name: string;
    redirectUris: readonly string[];
};

export interface ClientStore {
    find(clientId: string): Promise<Client | null>;
}
