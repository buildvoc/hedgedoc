import { MemexWikiConversationPanel } from '../../../components/memex/memex-wiki-conversation-panel'

import { MemexWikiCatalogue } from '../../../components/memex/memex-wiki-catalogue'
export default function MemexWikiPage() {
  return (
    <main
      style={{
        width: 'min(1100px, 100%)',
        margin: '0 auto',
        padding: '1.5rem',
      }}>
      <h1>Memex Wiki</h1>
      <p>
        Review conversation-driven wiki changes before committing them to the
        maintained derived wiki.
      </p>

      <section
        data-memex-wiki-chat-launcher
        style={{
          border: '1px solid var(--bs-border-color, #ced4da)',
          borderRadius: '0.5rem',
          padding: '1rem',
          marginTop: '1rem',
        }}>
        <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Wiki chat</h2>
        <p style={{ margin: '0.35rem 0 0.75rem' }}>
          Open the dedicated LLM + maintained-wiki RAG chat workspace.
        </p>
        <a href='/memex-wiki/chat'>Open Wiki Chat</a>
      </section>
      <MemexWikiCatalogue />

<MemexWikiConversationPanel />
    </main>
  )
}
