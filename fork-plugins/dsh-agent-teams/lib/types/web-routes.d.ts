import type { IncomingMessage, ServerResponse } from 'node:http';
/** Public WebServer route surface used by the plugin. */
export interface WebRouteHost {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        /**
         * Admission policy the host applies before the handler. 0.2.3-alpha.2 reads
         * it and defaults to `required`; hosts through 0.2.2 read only `kind`,
         * `path` and `handler`, so the field is ignored there.
         */
        auth?: 'required';
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
/**
 * Authentication gate for raw Web routes on hosts through 0.2.2.
 *
 * 0.2.3-alpha.2 removed `requestRejection` and authorizes every registered
 * route itself, which is why {@link authenticatedWebRoutes} registers
 * `auth: 'required'` and a gate without this method is treated as that host
 * generation. Its replacement, `admit(request)`, cannot stand in for the gate:
 * Cordis resolves a service method's `this.<sub-service>` read (in `admit`,
 * `this.authentication`) through the *calling* fiber's `inject` table, so
 * invoking it from this plugin's context throws instead of returning an
 * admission.
 */
export interface BrowserRequestGate {
    /** Rejecting status for one raw-route request; `undefined` admits it. */
    requestRejection?(request: IncomingMessage): number | undefined;
}
export declare class RequestBodyError extends Error {
    readonly status: 400 | 413;
    constructor(message: string, status: 400 | 413);
}
/** Bound memory while draining oversized requests so the route can return 413. */
export declare function readJsonRequest(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>;
/** Revalidate a current JSON representation across both identity and gzip delivery. */
export declare function writeJsonWithEtag(req: IncomingMessage, res: ServerResponse, body: string): void;
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
export declare function authenticatedWebRoutes(server: WebRouteHost, connection: () => BrowserRequestGate | undefined): WebRouteHost;
