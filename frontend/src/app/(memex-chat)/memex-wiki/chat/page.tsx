import { MemexWikiQueryPanel } from '../../../../components/memex/memex-wiki-query-panel'

export default function MemexWikiChatPage() {
  return (
    <main
      style={{
        width: 'min(1180px, calc(100% - 2rem))',
        margin: '0 auto',
        padding: '1rem 0',
        minHeight: '100vh',
        boxSizing: 'border-box',
      }}>
      <MemexWikiQueryPanel standalone />
    </main>
  )
}
