import Link from 'next/link'
import { MemexModelSettingsForm } from '../../../components/memex-settings/memex-model-settings-form'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function MemexSettingsPage() {
  return (
    <main
      style={{
        margin: '0 auto',
        maxWidth: '1000px',
        padding: '24px',
        width: '100%',
      }}
    >
      <header style={{ marginBottom: '24px' }}>
        <h1>Memex Model Settings</h1>
        <p>
          Central Ollama defaults for Process Pending and snapshot processing,
          including the desired runtime profile for the remote Ollama host.
          Snapshot source revisions remain independent of these settings.
        </p>
        <nav
          aria-label='Memex settings navigation'
          style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}
        >
          <Link href='/memex-snapshots'>Snapshots</Link>
          <Link href='/memex-association-review'>Association Review</Link>
          <Link href='/memex-index'>Index</Link>
          <Link href='/memex-log'>Log</Link>
          <Link href='/explore/my?memex=pending'>Pending</Link>
        </nav>
      </header>

      <MemexModelSettingsForm />
    </main>
  )
}
