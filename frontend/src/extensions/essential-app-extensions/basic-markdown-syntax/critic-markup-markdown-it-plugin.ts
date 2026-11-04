/* CRITIC_SIMPLE_THREAD_RAIL_V2 */
import type MarkdownIt from 'markdown-it'

type CriticKind = 'comment' | 'insert' | 'delete' | 'replace' | 'highlight'
interface CriticDefinition { kind: CriticKind; open: string; close: string }
interface CriticMessage { author: string; text: string }
const definitions: CriticDefinition[] = [
  { kind: 'comment', open: '{>>', close: '<<}' },
  { kind: 'insert', open: '{++', close: '++}' },
  { kind: 'delete', open: '{--', close: '--}' },
  { kind: 'replace', open: '{~~', close: '~~}' },
  { kind: 'highlight', open: '{==', close: '==}' }
]
const commentParts = (content: string): CriticMessage => {
  const match = /^@([^:]{1,80}):\s*([\s\S]*)$/.exec(content.trim())
  return match ? { author: match[1].trim(), text: match[2] } : { author: '', text: content.trim() }
}
export const criticMarkup = (markdownIt: MarkdownIt): void => {
  markdownIt.inline.ruler.before('text', 'critic_markup', (state, silent) => {
    const definition = definitions.find(({ open }) => state.src.startsWith(open, state.pos))
    if (!definition) return false
    const bodyStart = state.pos + definition.open.length
    const bodyEnd = state.src.indexOf(definition.close, bodyStart)
    if (bodyEnd < 0 || bodyEnd >= state.posMax) return false
    if (!silent) {
      const token = state.push(`critic_${definition.kind}`, '', 0)
      token.content = state.src.slice(bodyStart, bodyEnd)
      token.meta = { raw: state.src.slice(state.pos, bodyEnd + definition.close.length) }
    }
    state.pos = bodyEnd + definition.close.length
    return true
  })

  const escape = markdownIt.utils.escapeHtml
  const attr = (value: string): string => escape(value).replaceAll('"', '&quot;')

  markdownIt.renderer.rules.critic_comment = (tokens, index) => {
    if (index > 0 && tokens[index - 1].type === 'critic_comment') return ''
    const messages: CriticMessage[] = []
    const rawParts: string[] = []
    let resolved = false
    for (let i = index; i < tokens.length && tokens[i].type === 'critic_comment'; i++) {
      const token = tokens[i]
      const text = token.content.trim()
      if (text === '%%resolved%%') { resolved = true; continue }
      rawParts.push(String(token.meta?.raw || `{>>${token.content}<<}`))
      messages.push(commentParts(token.content))
    }
    if (!messages.length || resolved) return ''
    const raw = rawParts.join('')
    const encodedMessages = JSON.stringify(messages)
    const count = messages.length > 1 ? String(messages.length) : ''
    return `<span class="critic-comment" data-critic-raw="${attr(raw)}" data-critic-messages="${attr(encodedMessages)}" data-critic-resolved="0" title="${messages.length} review message${messages.length === 1 ? '' : 's'}">💬${count}</span>`
  }

  markdownIt.renderer.rules.critic_insert = (tokens, index) => `<ins class="critic-insert" title="Suggested insertion">${escape(tokens[index].content)}</ins>`
  markdownIt.renderer.rules.critic_delete = (tokens, index) => `<del class="critic-delete" title="Suggested deletion">${escape(tokens[index].content)}</del>`
  markdownIt.renderer.rules.critic_replace = (tokens, index) => {
    const content = tokens[index].content
    const split = content.indexOf('~>')
    const oldText = split < 0 ? content : content.slice(0, split)
    const newText = split < 0 ? content : content.slice(split + 2)
    return `<span class="critic-replace" title="Suggested replacement"><del>${escape(oldText)}</del><ins>${escape(newText)}</ins></span>`
  }
  markdownIt.renderer.rules.critic_highlight = (tokens, index) => `<mark class="critic-highlight" title="Review highlight">${escape(tokens[index].content)}</mark>`
}
