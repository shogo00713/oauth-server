export type User = {
    id: string;
    username: string;
    passwordHash: string;
};

export interface UserStore {
    findByUsername(username: string): Promise<User | null>;
    findById(id: string): Promise<User | null>;
}
