import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type z from '@deepseek-ai/schemastery'

export declare const name = 'simflow-relay'
export declare const inject: readonly ['webServer', 'agents', 'sessionController']

export interface Config {
  readonly path: string
  readonly tokenFile: string
  readonly maxBodyBytes: number
}
export declare const Config: z<Config>

export interface SimflowRelayRequest {
  readonly sessionId: string
  readonly slot: string
  readonly text: string
  readonly mailId?: string
  readonly mailKind?: string
}

export declare function simflowLead(slot: string): string
export declare function parseRelayRequest(body: string): SimflowRelayRequest
export declare function createSimflowMessage(request: SimflowRelayRequest): UserMessage
export declare function createRelayHandler(ctx: Context, config: Config): (request: unknown, response: unknown) => Promise<void>
export declare function apply(ctx: Context, config: Config): void

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Message relayed from the external SimFlow tool for one slot. */
    simflow: {
      readonly kind: 'simflow'
      readonly slot: string
      readonly mailId?: string
      readonly mailKind?: string
      readonly form: 'relay'
    }
  }
}
