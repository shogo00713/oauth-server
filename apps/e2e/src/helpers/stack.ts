/**
 * 本物の AS、RS、client を、別々のプロセスで起動する(結合テスト用)
 *   - 鍵、秘密、パスワードは、起動のたびに、その場で作る(ファイルは、一時フォルダの中だけ)
 *   - ポートは、空いている物を、その場で選ぶ(他のテストや、開発中のサーバーと、ぶつからない)
 *   - 環境変数は、必要な物だけを渡す(手元の .env や、シェルの設定に、左右されない)
 */
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// apps/ フォルダ(このファイルは、apps/e2e/src/helpers/ にある)
const APPS_DIR = resolve(fileURLToPath(import.meta.url), '../../../..');

export type ExitInfo = {
    code: number | null;
    signal: NodeJS.Signals | null;
};

export type RunningApp = {
    readonly port: number;
    readonly baseUrl: string;
    // これまでに出た、標準出力と標準エラー(失敗した時の手がかり)
    logs(): string;
    // 止める(既定は SIGTERM)。終わり方を返す。5 秒で終わらなければ、強制終了する
    stop(signal?: NodeJS.Signals): Promise<ExitInfo>;
};

export type Stack = {
    readonly as: RunningApp;
    // restartRs で入れ替わるので、いつも、今動いている物を返す
    readonly rs: RunningApp;
    readonly client: RunningApp;
    readonly issuer: string;
    readonly audience: string;
    // client が、AS に登録している戻り先
    readonly redirectUri: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly username: string;
    readonly password: string;
    readonly privateKeyPem: string;
    readonly publicKeyPem: string;
    // RS を止めて、同じ DB のファイルで、起動し直す。止めた時の終わり方を返す
    restartRs(signal?: NodeJS.Signals): Promise<ExitInfo>;
    // 全部止めて、一時フォルダを消す
    stop(): Promise<void>;
};

const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

const randomSecret = (bytes = 32) => randomBytes(bytes).toString('base64url');

// 空いているポートを、互いに違う物で 3 つ選ぶ
async function freePorts(): Promise<[number, number, number]> {
    const ports: number[] = [];
    while (ports.length < 3) {
        const port = await new Promise<number>((resolve, reject) => {
            const server = createServer();
            server.once('error', reject);
            server.listen(0, () => {
                const address = server.address();
                server.close(() =>
                    address !== null && typeof address === 'object'
                        ? resolve(address.port)
                        : reject(new Error('ポートを選べませんでした')),
                );
            });
        });
        if (!ports.includes(port)) ports.push(port);
    }
    return ports as [number, number, number];
}

type AppSpec = {
    name: string;
    // apps/ の下のフォルダ名
    dir: string;
    port: number;
    // 標準出力にこれが出たら、起動できたとみなす
    ready: string;
    env: Record<string, string>;
};

async function startApp(spec: AppSpec): Promise<RunningApp> {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: join(APPS_DIR, spec.dir),
        env: { PATH: process.env['PATH'] ?? '', ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    let logs = '';
    child.stdout.on('data', (chunk: Buffer) => {
        logs += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
        logs += chunk.toString();
    });

    // テストが、途中で終わってしまった時も、サーバーを残さない
    const killOnExit = () => child.kill('SIGKILL');
    process.once('exit', killOnExit);

    const state = { exit: undefined as ExitInfo | undefined };
    const exited = new Promise<ExitInfo>((resolve) => {
        child.once('exit', (code, signal) => {
            process.off('exit', killOnExit);
            state.exit = { code, signal };
            resolve(state.exit);
        });
    });

    const app: RunningApp = {
        port: spec.port,
        baseUrl: `http://localhost:${spec.port}`,
        logs: () => logs,
        async stop(signal = 'SIGTERM') {
            if (state.exit) return state.exit;
            child.kill(signal);
            const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
            try {
                return await exited;
            } finally {
                clearTimeout(timer);
            }
        },
    };

    const deadline = Date.now() + 30_000;
    while (!logs.includes(spec.ready)) {
        if (state.exit) {
            throw new Error(`${spec.name} が起動できませんでした:\n${logs}`);
        }
        if (Date.now() > deadline) {
            await app.stop('SIGKILL');
            throw new Error(
                `${spec.name} の起動を待ちきれませんでした:\n${logs}`,
            );
        }
        await sleep(50);
    }
    return app;
}

export async function startStack(): Promise<Stack> {
    const dir = mkdtempSync(join(tmpdir(), 'oauth-e2e-'));
    const [asPort, rsPort, clientPort] = await freePorts();

    const issuer = `http://localhost:${asPort}`;
    const rsBaseUrl = `http://localhost:${rsPort}`;
    const clientBaseUrl = `http://localhost:${clientPort}`;
    const redirectUri = `${clientBaseUrl}/callback`;

    // AS の署名鍵(秘密鍵)と、RS が使う公開鍵
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const privateKeyPath = join(dir, 'as-private.pem');
    const publicKeyPath = join(dir, 'as-public.pem');
    writeFileSync(privateKeyPath, privateKey);
    writeFileSync(publicKeyPath, publicKey);

    const clientId = 'memoboard';
    const clientSecret = randomSecret();
    const username = 'demo';
    const password = randomSecret(16);

    const specs = {
        as: {
            name: 'AS',
            dir: 'as',
            port: asPort,
            ready: '認可サーバーを起動しました',
            env: {
                ISSUER: issuer,
                PORT: String(asPort),
                SIGNING_KEY_PATH: privateKeyPath,
                SESSION_SECRET: randomSecret(),
                CLIENT_ID: clientId,
                CLIENT_NAME: 'メモボード',
                CLIENT_SECRET: clientSecret,
                CLIENT_REDIRECT_URIS: redirectUri,
                USER_NAME: username,
                USER_PASSWORD: password,
            },
        },
        rs: {
            name: 'RS',
            dir: 'rs',
            port: rsPort,
            ready: 'リソースサーバーを起動しました',
            env: {
                ISSUER: issuer,
                PORT: String(rsPort),
                VERIFY_KEY_PATH: publicKeyPath,
                // 置き場のフォルダは、まだ無い(RS が、作る)
                DB_PATH: join(dir, 'data', 'rs.db'),
            },
        },
        client: {
            name: 'client',
            dir: 'client',
            port: clientPort,
            ready: 'クライアントを起動しました',
            env: {
                BASE_URL: clientBaseUrl,
                PORT: String(clientPort),
                AS_BASE_URL: issuer,
                RS_BASE_URL: rsBaseUrl,
                CLIENT_ID: clientId,
                CLIENT_SECRET: clientSecret,
                SESSION_SECRET: randomSecret(),
            },
        },
    } satisfies Record<string, AppSpec>;

    const started = await Promise.allSettled([
        startApp(specs.as),
        startApp(specs.rs),
        startApp(specs.client),
    ]);
    const apps = started.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : [],
    );
    const failure = started.find((result) => result.status === 'rejected');
    if (failure) {
        await Promise.all(apps.map((app) => app.stop('SIGKILL')));
        rmSync(dir, { recursive: true, force: true });
        throw failure.reason;
    }
    const [as, firstRs, client] = apps as [RunningApp, RunningApp, RunningApp];

    let rs = firstRs;
    return {
        as,
        get rs() {
            return rs;
        },
        client,
        issuer,
        audience: 'simple-memo',
        redirectUri,
        clientId,
        clientSecret,
        username,
        password,
        privateKeyPem: privateKey,
        publicKeyPem: publicKey,
        async restartRs(signal) {
            const info = await rs.stop(signal);
            rs = await startApp(specs.rs);
            return info;
        },
        async stop() {
            await Promise.all([as.stop(), rs.stop(), client.stop()]);
            rmSync(dir, { recursive: true, force: true });
        },
    };
}
