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
 * routes, so their rejecting status is applied here before the handler reads or
 * mutates team state. 0.2.3-alpha.2 authorizes the registered route itself
 * through the same fence and credential providers, so there the host's own
 * `401`/`403`/`503` answer stands and the handler only runs for an admitted
 * peer.
 */
export function authenticatedWebRoutes(server, connection) {
    return {
        register(route) {
            return server.register({
                ...route,
                // 0.2.3-alpha.2 evaluates this policy before the handler; hosts through
                // 0.2.2 ignore the field and use the gate below instead.
                auth: 'required',
                async handler(req, res) {
                    const gate = connection();
                    // Missing/disposing Connection is an assembly failure, never an
                    // invitation to expose workspace state or accept plan mutations.
                    if (gate === undefined) {
                        res.writeHead(503, {
                            'content-type': 'application/json; charset=utf-8',
                            'cache-control': 'no-store',
                        });
                        res.end(JSON.stringify({ error: 'authentication unavailable' }));
                        return;
                    }
                    // A gate without `requestRejection` is a 0.2.3-alpha.2 Connection,
                    // whose WebServer already admitted this request.
                    const rejection = gate.requestRejection?.(req);
                    if (rejection !== undefined) {
                        res.writeHead(rejection, {
                            'content-type': 'application/json; charset=utf-8',
                            'cache-control': 'no-store',
                        });
                        res.end(JSON.stringify({ error: rejection === 401 ? 'unauthorized'
                                : rejection === 503 ? 'authentication unavailable' : 'forbidden' }));
                        return;
                    }
                    await route.handler(req, res);
                },
            });
        },
    };
}
