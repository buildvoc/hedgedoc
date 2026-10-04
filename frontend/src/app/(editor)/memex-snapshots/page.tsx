import Link from 'next/link'
import { MemexCreateSnapshotButton } from '../../../components/memex-readonly/memex-create-snapshot-button'
import { MemexReadOnlyMarkdown } from '../../../components/memex-readonly/memex-readonly-markdown'
import { MemexRevisionsButton } from '../../../components/memex-readonly/memex-revisions-button'
import { fetchMemexNoteContent } from '../../memex-revisions/_proxy'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const MEMEX_SNAPSHOTS_ALIAS = 'memex-snapshots'

export default async function MemexSnapshotsPage() {
  let content = ''
  let errorMessage = ''

  try {
    content = await fetchMemexNoteContent(MEMEX_SNAPSHOTS_ALIAS)
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : 'Unable to read Memex snapshots note'
  }

  return (
    <main style={{ width: '100%' }}>
      <header
        style={{
          margin: '0 auto',
          maxWidth: '1200px',
          padding: '24px 24px 12px',
          width: '100%',
        }}
      >
        <h1 style={{ marginBottom: '8px' }}>Memex Snapshots</h1>
        <p style={{ margin: 0 }}>
          HedgeDoc-backed snapshots: the current note is <strong>main</strong> and its
          HedgeDoc revisions are snapshots.
        </p>
        <nav
          aria-label='Memex read-only files'
          style={{
            alignItems: 'center',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '12px',
            marginTop: '16px',
          }}
        >
          <Link href='/memex-index'>Index</Link>
          <Link href='/memex-log'>Log</Link>
          <Link href='/memex-snapshots'>Snapshots</Link>
          <Link href='/memex-settings'>Model Settings</Link>
          <Link href='/memex-association-review'>Association Review</Link>
          <Link href='/memex-association-benchmarks'>Benchmarks</Link>
          <MemexCreateSnapshotButton />
          <Link href={`/n/${MEMEX_SNAPSHOTS_ALIAS}`}>Edit Main</Link>
          <Link href='/explore/my?memex=pending'>Process Pending</Link>
          <MemexRevisionsButton
            noteAlias={MEMEX_SNAPSHOTS_ALIAS}
            allowSnapshotQueue={true}
            allowSnapshotExtend={true}
            allowBenchmark={true}
          />
        </nav>
      </header>

      {errorMessage ? (
        <pre
          role='alert'
          style={{
            margin: '12px auto 24px',
            maxWidth: '1200px',
            padding: '16px 24px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {`Unable to read HedgeDoc note /n/${MEMEX_SNAPSHOTS_ALIAS}\n${errorMessage}`}
        </pre>
      ) : (
        <MemexReadOnlyMarkdown content={content} />
      )}
    </main>
  )
}
