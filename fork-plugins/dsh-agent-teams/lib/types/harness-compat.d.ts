/**
 * The audited Harness 0.1.2 / 0.1.5 / 0.1.7 subagent boundary. Keep version-specific shapes
 * here: API presence alone is not a promise of support for future versions.
 *
 * Alpha.2 owns followup/registerContinuableSetup; Alpha.5 and rc.1 own a
 * host-only FIFO queue; 0.1.5 uses a queue/steer deliverer. Both emit
 * synchronous agent/session-start with the explicit Agent. Their public
 * sendMessage instead steers a running Agent and must never carry team jobs.
 */
import type { Context } from '@deepseek-ai/cordis';
import { type Agent, type AgentOptions, type ModelSelection } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, MessageId, MessageSource } from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import { type MemberToolFilter } from './tool-policies.ts';
type Setup = (childCtx: Context, child: Agent) => () => void;
/** Version-independent creation contract; legacy-only options stay at this seam. */
export interface MemberStartSpec {
    provider: string;
    label: string;
    request: {
        parent: Agent;
        prompt: ContentBlock[];
        agentOptions?: AgentOptions;
        persona?: string;
        toolFilter?: MemberToolFilter;
    };
    signal: AbortSignal;
}
export declare function usesManagedActivations(runtime: Context['subagents']): boolean;
export declare function startMember(runtime: Context['subagents'], spec: MemberStartSpec): Promise<{
    childId: SessionId;
}>;
/** Wrap every available creation API, restoring only this plugin's own methods. */
export declare function guardSubagentCreation(ctx: Context, check: (parent: Agent) => void): void;
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'agent-teams': {
            readonly kind: 'agent-teams';
        };
    }
}
/** Package identity a released plugin-wrapper source names on older hosts. */
export declare const AGENT_TEAMS_PLUGIN_NAME = "@nanmicoder/dsh-agent-teams";
/**
 * First stored format generation whose migration edges admit producer-owned
 * source kinds. The released v2→v3 payload audit validates every message source
 * against a closed list of released kinds, so a stored format older than this
 * must carry a released source or the whole session becomes unreadable once a
 * newer host opens it (#160).
 */
export declare const RELEASED_SOURCE_VOCABULARY_VERSION = 3;
/** Source kinds this plugin mints on a host whose stored format admits them. */
export type AgentTeamsSource = {
    readonly kind: 'agent-teams';
} | {
    readonly kind: 'agent-teams-command';
    readonly goal?: string;
    readonly profile?: string;
};
/** Stored session format generation of the running host; 0 when it exposes none. */
export declare function hostSessionFormatVersion(): number;
/**
 * Source for one AgentTeams-authored message on the running host.
 *
 * Current hosts mint producer-owned kinds: the Harness documents message
 * sources as a merge-extensible vocabulary without a catch-all, so this plugin
 * declares its own. Hosts that still store a pre-v3 generation are a different
 * contract — their released v2→v3 migration rejects any source outside the
 * released vocabulary, which is exactly how a plugin kind written on an older
 * supported host poisons its session log for every later host. On those hosts
 * the released plugin wrapper is used instead; the goal and profile already
 * travel in the message text.
 * @param modern - the producer-owned source to use where the host admits it.
 * @returns a source accepted by the running host and by its migration chain.
 */
export declare function agentTeamsSource(modern: AgentTeamsSource): MessageSource;
/**
 * 0.1.6 moved startup admission to serial agent/created. Older created events
 * have no source and precede session-start; ignore those until the old hook.
 * Keep the removed event's type confined to this audited compatibility seam.
 */
export declare function onAgentReady(ctx: Context, listener: (agent: Agent, vetoable: boolean) => void): () => void;
/** Read child-owned history, excluding any descriptor inherited from a parent. */
export declare function sessionOwnEvents(session: Session): readonly SessionEvent[];
/** Install before the first request, including cold resume, with HMR cleanup. */
export declare function installContinuableMemberSetup(ctx: Context, setup: Setup): void;
/**
 * Mutable route the pre-0.2.2 host loop reads inside its request hook. Hosts
 * that own selection on the Agent keep this object inert.
 */
export interface MemberModelSelectionRef {
    /** Route the next step should use; the fallback switch rewrites it. */
    current: ModelSelection | undefined;
    /** Route the current step captured during prompt assembly. */
    assembled: ModelSelection | undefined;
}
/**
 * Whether this Agent owns its model selection. 0.2.2 moved selection from the
 * request hook's mutable ref to `Agent.model`: the loop captures the route
 * before prompt assembly and rejects a request-time replacement, so a route
 * change is recorded for the next step instead of rewriting the current one.
 * @param agent - the member Agent to inspect.
 * @returns whether the running host owns model selection on each Agent.
 */
export declare function hostOwnsModelSelection(agent: Agent): boolean;
/**
 * Install the member's route contributions on the running host.
 *
 * A host that owns selection only needs the switch notice: the route travels in
 * the child's creation options and in recorded selections. Older hosts consume
 * the mutable ref, so the plugin must supply every request route itself.
 * @param ctx - the member Agent's scoped context.
 * @param agent - the member Agent receiving route and notice contributions.
 * @param selection - mutable route consumed by hosts without Agent-owned selection.
 * @returns Disposer for the installed selection contributions.
 */
export declare function installMemberModelSelection(ctx: Context, agent: Agent, selection: MemberModelSelectionRef): () => void;
/**
 * Record a member route the running host would not otherwise start from.
 *
 * A cold resume restores the descriptor's creation route, while a member that
 * already failed over keeps running on its saved backup route. Recording the
 * saved choice is the only supported way to start a step there on hosts that
 * own selection; an equal choice is skipped so no redundant `model/selection`
 * event enters the session log.
 * @param agent - the member Agent to route.
 * @param selection - the member's saved route.
 */
export declare function recordMemberModelSelection(agent: Agent, selection: ModelSelection): void;
/**
 * Apply one accepted fallback route to a member whose request already failed.
 *
 * Hosts without Agent-owned selection rewrite the captured request route, so
 * the recovery action retries the failed step on the backup route. From 0.2.2
 * the loop fixes the step's route before assembly and refuses a replacement:
 * this recovery records the backup route for the next step and declines the
 * retry, so the failed attempt keeps its own outcome instead of repeating on
 * the primary route.
 * @param agent - the member Agent whose request failed.
 * @param selection - mutable legacy route ref.
 * @param next - the backup route to run.
 * @returns the recovery action for hosts without Agent-owned selection.
 */
export declare function applyFallbackRoute(agent: Agent, selection: MemberModelSelectionRef, next: ModelSelection): {
    kind: 'retry';
} | undefined;
/** Queue a distinct host-authored turn; never substitute model-message steer. */
export declare function queueMemberPrompt(runtime: Context['subagents'], parent: Agent, childId: SessionId, content: ContentBlock[], signal: AbortSignal): Promise<MessageId>;
/** Coordination joins the nearest step, including waking an idle/cold child. */
export declare function steerMemberPrompt(runtime: Context['subagents'], parent: Agent, childId: SessionId, content: ContentBlock[], signal: AbortSignal, live?: Agent): Promise<MessageId>;
/** Guard all resumable delivery paths, preserving the native service receiver. */
export declare function guardSubagentDelivery(ctx: Context, isRetired: (sender: Agent, targetId: SessionId) => Promise<boolean>): void;
/**
 * Names the host's `tools.restrict()` would admit for this agent's layer
 * chain, or undefined when the host does not expose its registry view.
 * restrict() rejects unknown names with a hard error, so the spawn path must
 * check entries against this view before forwarding them. Source:
 * dsh-tools view()/restrict() in 0.1.5-rc.1; older Harness generations lack
 * the surface and keep the verbatim list.
 */
export declare function restrictableToolNames(agent: Agent): ReadonlySet<string> | undefined;
/**
 * Member `toolFilter` for one spawn. Captain-only names are registered by
 * this plugin itself and always resolvable; the depth-related entries name
 * HOST tools and are only known under some compositions, so they must be
 * resolved against the running host's registry: the delegation tool name is
 * host configuration (dsh-tool-subagent `toolName`, default `subagent`,
 * renamed per composition, e.g. `subagent_fork` in web-style profiles), and
 * forwarding a name the host dropped aborts every member spawn (#163, #164).
 * Depth enforcement itself does not depend on these names —
 * installMemberDelegationGuard bounds descendant creation by parent chain.
 *
 * This is the legacy filter of a member without a configured tool policy; a
 * selected policy resolves through `resolveMemberToolFilter` instead (#59).
 */
export declare function memberToolFilter(maxDepth: number | undefined, knownTools: ReadonlySet<string> | undefined): MemberToolFilter;
/**
 * Start one member, dropping only the built-in filter names the host reports
 * as unknown and retrying.
 *
 * Resolving the filter against the registry view ({@link memberToolFilter})
 * only covers hosts that expose one. A rejected filter still leaves the member
 * without a session for the lifetime of the team, so the start must survive the
 * cases that resolution cannot see — no registry view, a name that is known but
 * not restrictable, a composition that mounted differently than expected. The
 * host names the offenders in its rejection, so the relaxable ones are removed
 * and the start retried.
 *
 * Only `relaxableDeny` names may be dropped, and only from `deny`. The default
 * is exactly the built-in captain-only and depth entries (#163/#164); a name an
 * owner-declared tool policy contributed is never removed, because silently
 * spawning a member with a different filter than the owner declared is contract
 * drift, not recovery. Dropping a denied name the host does not register
 * changes nothing; dropping an allowed name would loosen the policy, so `allow`
 * is never relaxed and the four required coordination tools can never be
 * removed.
 * @param start - performs one start attempt for the given `toolFilter`.
 * @param filter - the filter to attempt first.
 * @param relaxableDeny - built-in deny names the retry may drop.
 * @returns the started member.
 */
export declare function startMemberWithLenientFilter<T>(start: (filter: MemberToolFilter) => Promise<T>, filter: MemberToolFilter, relaxableDeny?: readonly string[]): Promise<T>;
/** Targeted recursive cancellation renamed with the unified activation manager. */
export declare function drainMemberChildren(runtime: Context['subagents'], parent: Agent, ids: readonly SessionId[]): Promise<void>;
export {};
