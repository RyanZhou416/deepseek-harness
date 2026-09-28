/** Hide superseded Chat rows while retaining the immutable Session log and cost history. */
import type { ChatConversationViewNode, ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'

type Range = { readonly start: number; readonly before: number }

/** Incremental visibility of ordinary messages and responses replaced by a human revision. */
export class MessageRevisionProjector {
  private ranges: Range[] = []

  /**
   * Rebuild revision visibility from a complete loaded window.
   * @param nodes - Chat business nodes, including committed revisions.
   * @returns nodes with superseded rows hidden.
   */
  replace(nodes: readonly ChatConversationViewNode[]): readonly ChatConversationViewNode[] {
    this.ranges = []
    this.collect(nodes)
    return nodes.map(node => this.project(node))
  }

  /**
   * Apply new revisions to existing rows and all subsequent updates.
   * @param upserts - new or changed Chat nodes.
   * @param store - current keyed Chat nodes.
   * @returns updates including newly hidden historical rows.
   */
  apply(upserts: readonly ChatConversationViewNode[], store: ChatNodeStore): readonly ChatConversationViewNode[] {
    const extended = this.collect(upserts)
    const result = upserts.map(node => this.project(node))
    if (extended) {
      const incoming = new Set(upserts.map(node => node.key))
      for (const node of store.values()) {
        if (incoming.has(node.key)) continue
        const projected = this.project(node)
        if (projected !== node) result.push(projected)
      }
    }
    return result
  }

  private collect(nodes: readonly ChatConversationViewNode[]): boolean {
    let extended = false
    for (const node of nodes) {
      if (node.kind !== 'user') continue
      const range = (node as ChatNode<'user'>).data.editedRange
      if (range === undefined || this.ranges.some(previous => previous.start === range.start && previous.before === range.before)) continue
      this.ranges.push(range)
      extended = true
    }
    return extended
  }

  private project(node: ChatConversationViewNode): ChatConversationViewNode {
    const seq = node.kind === 'user' ? (node as ChatNode<'user'>).data.seq : node.anchorSeq
    return node.visibility === 'visible' && this.ranges.some(range => seq >= range.start && seq < range.before)
      ? { ...node, visibility: 'hidden' } : node
  }
}
