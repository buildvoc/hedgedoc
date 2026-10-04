import Link from 'next/link'
import { MemexAssociationReview } from '../../../components/memex-associations/memex-association-review'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function MemexAssociationReviewPage() {
  return (
    <main
      style={{
        margin: '0 auto',
        maxWidth: '1100px',
        padding: '24px',
        width: '100%',
      }}
    >
      <header style={{ marginBottom: '24px' }}>
        <h1>Association Review</h1>
        <p>
          The main Memex model can suggest direct source associations. There is
          no automated verifier: human review here is the verification step, and
          no suggestion enters the canonical association store until you accept it.
        </p>
        <nav
          aria-label='Memex association review navigation'
          style={{ display: 'flex', flexWrap: 'wrap', gap: '12px' }}
        >
          <Link href='/memex-settings'>Model Settings</Link>
          <Link href='/memex-association-benchmarks'>Benchmarks</Link>
          <Link href='/memex-snapshots'>Snapshots</Link>
          <Link href='/memex-index'>Index</Link>
          <Link href='/memex-log'>Log</Link>
          <Link href='/explore/my?memex=pending'>Pending</Link>
        </nav>
      </header>

      <MemexAssociationReview />
    </main>
  )
}
