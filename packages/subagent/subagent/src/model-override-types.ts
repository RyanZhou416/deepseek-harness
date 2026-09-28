/** User-selected model configuration for newly created Harness-managed children. */
export interface SubagentModelOverride {
  /** Registered LLM provider id. */
  readonly provider: string
  /** Exact model id owned by that provider. */
  readonly model: string
  /** Explicit reasoning effort; omission selects this model's default without parent inheritance. */
  readonly reasoningEffort?: string
}
