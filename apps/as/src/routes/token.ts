import express, {
    type NextFunction,
    type Request,
    type Response,
    type Router,
} from 'express';
import type { AppDeps } from '../app.js';
import { issueAccessToken } from '../lib/access-token.js';
import { parseClientCredentials } from '../lib/client-auth.js';
import { sha256Hex, verifySecret } from '../lib/hash.js';
import { verifyCodeChallenge } from '../lib/pkce.js';
import { haveSameRedirectUri } from '../lib/redirect-uri.js';
import { parseTokenRequest } from '../lib/token-request.js';
import {
    buildTokenError,
    buildTokenSuccess,
    type TokenResponse,
} from '../lib/token-response.js';

// 例外から、status(数字)を取り出す。無ければ null
const statusOf = (error: unknown): number | null =>
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
        ? error.status
        : null;

export function createTokenRouter(deps: AppDeps): Router {
    const router = express.Router();
    const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

    // レスポンスを構成する関数
    const send = (res: Response, response: TokenResponse) => {
        res.status(response.status).set(response.headers).json(response.body);
    };

    router.post(
        '/',
        express.urlencoded({ extended: false }),
        async (req, res) => {
            const credentials = parseClientCredentials(
                req.headers.authorization,
            );
            if (!credentials) {
                return send(res, buildTokenError('invalid_client'));
            }

            const client = await deps.clientStore.find(credentials.clientId);
            if (!client) {
                return send(res, buildTokenError('invalid_client'));
            }

            const isValidSecret = verifySecret(
                credentials.clientSecret,
                client.secretHash,
            );
            if (!isValidSecret) {
                return send(res, buildTokenError('invalid_client'));
            }

            const parsed = parseTokenRequest(req.body);
            if (!parsed.ok) {
                return send(res, buildTokenError(parsed.error));
            }

            const request = parsed.value;

            if (
                request.clientId !== undefined &&
                request.clientId !== credentials.clientId
            ) {
                return send(res, buildTokenError('invalid_request'));
            }

            const codeHash = sha256Hex(request.code);

            const record = await deps.codeStore.consume(codeHash, now());

            if (!record) {
                return send(res, buildTokenError('invalid_grant'));
            }

            const isSameClient = record.clientId === credentials.clientId;

            const isSameRedirectUri = haveSameRedirectUri(request.redirectUri, [
                record.redirectUri,
            ]);

            const isValidChallenge = verifyCodeChallenge(
                request.codeVerifier,
                record.codeChallenge,
            );

            if (!isSameClient || !isSameRedirectUri || !isValidChallenge) {
                return send(res, buildTokenError('invalid_grant'));
            }

            const accessToken = await issueAccessToken({
                privateKey: deps.signingKey.privateKey,
                kid: deps.signingKey.kid,
                issuer: deps.config.issuer,
                audience: deps.config.audience,
                subject: record.sub,
                clientId: credentials.clientId,
                scope: record.scope,
                ttlSec: deps.config.accessTokenTtlSec,
                now: now(),
            });

            return send(
                res,
                buildTokenSuccess({
                    accessToken,
                    expiresIn: deps.config.accessTokenTtlSec,
                    scope: record.scope,
                }),
            );
        },
    );

    router.all('/', (_req, res) => {
        res.status(405).set('Allow', 'POST').end();
    });

    router.use(
        (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
            const status = statusOf(error);
            if (status !== null && status >= 400 && status < 500) {
                return send(res, buildTokenError('invalid_request'));
            }

            console.error(error);
            res.status(500)
                .set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' })
                .json({ error: 'server_error' });
        },
    );

    return router;
}
