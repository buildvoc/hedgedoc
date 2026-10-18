import Link from 'next/link'
import { WikiGoldReview } from '../../../components/memex-summary-quality/wiki-gold-review'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function WikiSummaryQualityPage({ searchParams }: {
  searchParams?: { snapshotRevision?: string | string[] }
}) {
  const raw = searchParams?.snapshotRevision
  const snapshotRevision = typeof raw === 'string' && /^[0-9a-f-]{16,64}$/i.test(raw) ? raw : ''
  return (
    <main style={{ margin: '0 auto', maxWidth: 1280, padding: 24, width: '100%' }}>
      <header style={{ marginBottom: 24 }}>
        <h1>Wiki Summary Quality Benchmarks</h1>
        <p>Gold review for the original HedgeDoc and frozen reference in the selected snapshot. This stage does not run a model or change associations.</p>
        <nav aria-label='Wiki benchmark navigation' style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          <Link href='/memex-snapshots'>Snapshots</Link>
          <Link href='/memex-association-benchmarks'>Association Benchmarks</Link>
          <Link href='/memex-settings'>Model Settings</Link>
        </nav>
      </header>
      <WikiGoldReview snapshotRevision={snapshotRevision} />
    </main>
  )
}
