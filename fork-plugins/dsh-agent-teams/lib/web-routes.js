export class RequestBodyError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}
/** Bound memory while draining oversized requests so the route can return 413. */
export async function readJsonRequest(req, maxBytes = 1_000_000) {
    const raw = await new Promise((resolve, reject) => {
        let size = 0;
        let settled = false;
        const chunks = [];
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            req.off('data', onData);
            req.off('end', onEnd);
            req.off('aborted', onAborted);
            req.off('error', onError);
            if (error) {
                chunks.length = 0;
                // IncomingMessage may still receive data; discard it without buffering.
                req.once('error', () => { });
                req.resume();
                reject(error);
            }
            else {
                resolve(Buffer.concat(chunks).toString('utf8'));
            }
        };
        const onData = (chunk) => {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += part.length;
            if (size > maxBytes)
                finish(new RequestBodyError('request body is too large', 413));
            else
                chunks.push(part);
        };
        const onEnd = () => finish();
        const onAborted = () => finish(new RequestBodyError('request body was aborted', 400));
        const onError = () => finish(new RequestBodyError('invalid request body', 400));
        req.on('data', onData);
        req.once('end', onEnd);
        req.once('aborted', onAborted);
        req.once('error', onError);
    });
    let value;
    try {
        value = raw.trim() === '' ? {} : JSON.parse(raw);
    }
    catch {
        throw new RequestBodyError('invalid JSON', 400);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new RequestBodyError('body must be an object', 400);
    }
    return value;
}
/**
 * Require an admitted Connection peer before a raw WebServer route runs.
 *
 * Hosts through 0.2.2 do not inherit Connection's authentication fence for raw
 * routes. 0.2.3-alpha.2 authorizes every registered route itself and defaults
 * the policy to `required`; the wrapper still applies there so the panel keeps
 * its own `401`/`403`/`503` JSON reports and one response contract across the
 * declared generations.
 */
export function authenticatedWebRoutes(server, connection) {
    return {
        register(route) {
            return server.register({
                ...route,
                async handler(req, res) {
                    const gate = connection();
                    // Missing/disposing Connection is an assembly failure, never an
                    // invitation to expose workspace state or accept plan mutations.
                    const admission = gate?.admit(req);
                    const rejection = admission === undefined ? 503 : 'rejection' in admission ? admission.rejection : undefined;
                    if (rejection !== undefined) {
                        res.writeHead(rejection, {
                            'content-type': 'application/json; charset=utf-8',
                            'cache-control': 'no-store',
                        });
                        res.end(JSON.stringify({ error: rejection === 503 ? 'authentication unavailable'
                                : rejection === 401 ? 'unauthorized' : 'forbidden' }));
                        return;
                    }
                    await route.handler(req, res);
                },
            });
        },
    };
}
