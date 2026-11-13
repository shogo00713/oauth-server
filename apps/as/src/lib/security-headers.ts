import type { RequestHandler } from 'express';
import helmet from 'helmet';

export function securityHeaders(): RequestHandler {
    return helmet({
        frameguard: { action: 'deny' },
        contentSecurityPolicy: {
            useDefaults: true,
            directives: {
                'frame-ancestors': ["'none'"],
                'form-action': null,
                'upgrade-insecure-requests': null,
            },
        },
    });
}

export const noStore: RequestHandler = (_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
    next();
};
