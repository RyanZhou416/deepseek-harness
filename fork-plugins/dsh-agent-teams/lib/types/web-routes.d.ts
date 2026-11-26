import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
/** Public WebServer route surface used by the plugin. */
export interface WebRouteHost {
    register(route: {
        kind: 'exact' | 'prefix';
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
    }): () => void;
}
/**
 * Authentication gate for raw Web routes. Hosts through 0.2.2 publish the same
 * decision as `requestRejection`; every declared host accepts `admit` and
 * returns the rejecting status, which keeps one call path for all of them.
 */
export type BrowserRequestGate = Pick<HostConnectionService, 'admit'>;
export declare class RequestBodyError extends Error {
    readonly status: 400 | 413;
    constructor(message: string, status: 400 | 413);
}
/** Bound memory while draining oversized requests so the route can return 413. */
export declare function readJsonRequest(req: IncomingMessage, maxBytes?: number): Promise<Record<string, unknown>>;
/**
 * Require an admitted Connection peer before a raw WebServer route runs.
 *
 * Hosts through 0.2.2 do not inherit Connection's authentication fence for raw
 * routes. 0.2.3-alpha.2 authorizes every registered route itself and defaults
 * the policy to `required`; the wrapper still applies there so the panel keeps
 * its own `401`/`403`/`503` JSON reports and one response contract across the
 * declared generations.
 */
export declare function authenticatedWebRoutes(server: WebRouteHost, connection: () => BrowserRequestGate | undefined): WebRouteHost;
