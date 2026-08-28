/** Expanded Tool-row content, mounted only while its disclosure is open. */
import { CodeBlock, DiffBlock, IconInspectOutline12, ReadBlock, SearchBlock, TerminalBlock, WebBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { CHAT_DIFF_MAX_LINES, type DiffCardModel } from '../models/diff-card-model.ts'
import { CHAT_READ_MAX_LINES, type ReadCardModel } from '../models/read-card-model.ts'
import { CHAT_SEARCH_MAX_LINES, type SearchCardModel } from '../models/search-card-model.ts'
import { localizeTerminalCardModel, terminalBlockLabels, type TerminalCardModel } from '../models/terminal-card-model.ts'
import { diffBlockLabels, readBlockLabels, searchBlockLabels, webBlockLabels } from '../models/primitive-labels.ts'
import type { AskQuestionCardModel } from '../models/ask-question-card-model.ts'
import type { ToolRowDetailsModel, ToolRowState, ToolRowVariant } from '../models/tool-call-model.ts'
import type { WebCardModelProps } from '../models/web-card-model.ts'
import { AskQuestionCard } from './AskQuestionCard.tsx'
import css from './ToolRow.module.css'

/** Material needed only by an expanded Tool row. */
export interface ToolRowBodyProps {
  t: TranslateNS<'conversation'>
  variant: ToolRowVariant
  details: ToolRowDetailsModel
  showInput: boolean
  state: ToolRowState
  askQuestion: AskQuestionCardModel | null
  terminal: TerminalCardModel | null
  diff: DiffCardModel | null
  read: ReadCardModel | null
  search: SearchCardModel | null
  web: WebCardModelProps | null
  inspect?: (() => void) | undefined
}

/**
 * Render the structured or text details for one open Tool row.
 * @param props - normalized detail material and locale callbacks.
 * @returns the expanded Tool details body.
 */
export function ToolRowBody({
  t, variant, details, showInput, state, askQuestion, terminal, diff, read, search, web, inspect,
}: ToolRowBodyProps) {
  let content: ReactNode
  if (askQuestion !== null) {
    content = <AskQuestionCard card={askQuestion} />
  } else if (terminal !== null) {
    const localized = localizeTerminalCardModel(terminal, t)
    content = (
      <TerminalBlock
        {...localized.card}
        maxLines={Infinity}
        labels={terminalBlockLabels(t)}
        className={css.terminalBody}
      />
    )
  } else if (diff !== null) {
    content = <DiffBlock {...diff.card} labels={diffBlockLabels(t)} maxLines={CHAT_DIFF_MAX_LINES} className={css.diffBody} />
  } else if (read !== null) {
    content = <ReadBlock {...read} labels={readBlockLabels(t)} maxLines={CHAT_READ_MAX_LINES} className={css.readBody} />
  } else if (search !== null) {
    content = (
      <>
        <SearchBlock {...search.card} labels={searchBlockLabels(t)} maxLines={CHAT_SEARCH_MAX_LINES} className={css.searchBody} />
        {search.recovery !== undefined && (
          <div className={css.searchRecovery}>{search.recovery}</div>
        )}
      </>
    )
  } else if (web !== null) {
    content = <WebBlock {...web} labels={webBlockLabels(t)} className={css.webBody} />
  } else {
    // Pretty args and flattened output can be very large. Their lazy getters
    // are intentionally first read only in this mounted, cardless branch.
    const body = showInput ? details.body : null
    const output = details.output
    const cardBody = variant === 'code' ? null : body
    content = (
      <>
        {variant === 'code' && body !== null && (
          <div className={css.bodyScroll}>
            <CodeBlock
              code={body}
              lang="typescript"
              copyLabel={t('copy')}
              copiedLabel={t('copied')}
              className={css.codeBody}
            />
          </div>
        )}
        {(cardBody !== null || output !== null) && (
          <div className={css.ioCard}>
            {cardBody !== null && (
              <div className={css.ioSection}>
                <span className={css.ioLabel}>{t('row.input')}</span>
                <span className={css.ioText}>{cardBody}</span>
              </div>
            )}
            {cardBody !== null && output !== null && (
              <span className={css.ioDivider} aria-hidden />
            )}
            {output !== null && (
              <div className={css.ioSection}>
                <span className={css.ioLabel}>{t('row.output')}</span>
                <span className={css.ioText} data-error={state === 'error' || undefined}>
                  {output}
                </span>
              </div>
            )}
          </div>
        )}
      </>
    )
  }
  return (
    <div className={css.bodyWrap}>
      {content}
      {inspect !== undefined && (
        <button
          type="button"
          className={css.inspectButton}
          onClick={inspect}
        >
          <IconInspectOutline12 />
          {t('row.inspect')}
        </button>
      )}
    </div>
  )
}
