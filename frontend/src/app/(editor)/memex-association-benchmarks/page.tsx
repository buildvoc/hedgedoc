import Link from 'next/link'
import { MemexAssociationBenchmarks } from '../../../components/memex-associations/memex-association-benchmarks'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface MemexAssociationBenchmarksPageProps {
  searchParams?: {
    snapshotRevision?: string | string[]
  }
}

export default function MemexAssociationBenchmarksPage({
  searchParams,
}: MemexAssociationBenchmarksPageProps) {
  const rawSnapshotRevision = searchParams?.snapshotRevision
  const snapshotRevision =
    typeof rawSnapshotRevision === 'string' &&
    /^[0-9a-f-]{16,64}$/i.test(rawSnapshotRevision)
      ? rawSnapshotRevision
      : ''
  return (
    <main
      style={{
        margin: '0 auto',
        maxWidth: '1280px',
        padding: '24px',
        width: '100%',
      }}
    >
      <header style={{ marginBottom: '24px' }}>
        <h1>Association Quality Benchmarks</h1>
        <p>
          Annif-style evaluation history for Memex associations. Aggregate metric
          files drive the quality graph; detailed result files retain the exact
          source-pair decisions behind each score.
        </p>
        <nav
          aria-label='Memex association benchmark navigation'
          style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}
        >
          <Link href='/memex-association-review'>Association Review</Link>
          <Link href='/memex-settings'>Model Settings</Link>
          <Link href='/memex-snapshots'>Snapshots</Link>
          <Link href='/memex-index'>Index</Link>
          <Link href='/memex-log'>Log</Link>
        </nav>
      </header>

      <MemexAssociationBenchmarks snapshotRevision={snapshotRevision} />
    </main>
  )
}
