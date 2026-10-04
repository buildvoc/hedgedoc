'use client'

import { useEffect, useMemo, useState } from 'react'

type TrailMember = {
  alias: string
  title?: string
}

type Trail = {
  id: string
  name: string
  reason?: string
  origin?: string
  status?: string
  members: TrailMember[]
}

type PairwiseReview = {
  trailIds: [string, string]
  trailNames?: [string, string]
  classification: string
  confidence: number
  overlap: string
  distinction: string
  recommendation: string
}

type ReviewResponse = {
  ok: boolean
  readOnly: boolean
  model: string
  selectedTrailCount: number
  expectedPairCount: number
  reviewedPairCount: number
  repairCalls: number
  deterministicEvidence: Array<{
    trailIds: [string, string]
    sharedMemberAliases: string[]
    sharedMembers: number
    unionMembers: number
    jaccard: number
  }>
  review: {
    classification: string
    confidence: number
    summary: string
    recommendation: string
    distinctions: string[]
    pairwise: PairwiseReview[]
  }
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeMember(value: unknown): TrailMember | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const alias = asText(row.alias)
  if (!alias) return null
  return {
    alias,
    title: asText(row.title) || undefined,
  }
}

function normalizeTrail(value: unknown): Trail | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = asText(row.id)
  const name = asText(row.name)
  if (!id || !name) return null

  return {
    id,
    name,
    reason: asText(row.reason) || undefined,
    origin: asText(row.origin) || undefined,
    status: asText(row.status) || undefined,
    members: Array.isArray(row.members)
      ? row.members.map(normalizeMember).filter((item): item is TrailMember => item !== null)
      : [],
  }
}

function extractTrails(payload: unknown): Trail[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeTrail).filter((trail): trail is Trail => trail !== null)
  }

  if (!payload || typeof payload !== 'object') return []
  const row = payload as Record<string, unknown>

  const candidates: unknown[] = []
  for (const key of ['trails', 'systemTrails', 'userTrails']) {
    const value = row[key]
    if (Array.isArray(value)) candidates.push(...value)
  }

  return candidates
    .map(normalizeTrail)
    .filter((trail): trail is Trail => trail !== null)
}

function displayClassification(value: string): string {
  return value.replaceAll('_', ' ')
}

function confidencePercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function pairKey(pair: PairwiseReview): string {
  return [...pair.trailIds].sort().join('::')
}

function isAutoChangeCandidate(pair: PairwiseReview, threshold: number): boolean {
  return (
    (pair.classification === 'strong_overlap' || pair.classification === 'duplicate') &&
    pair.confidence >= threshold
  )
}

export function TrailOverlapReview() {
  const [trails, setTrails] = useState<Trail[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [loadingCatalog, setLoadingCatalog] = useState(true)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ReviewResponse | null>(null)
  const [autoSelectConfidence, setAutoSelectConfidence] = useState(0.85)
  const [selectedPairKeys, setSelectedPairKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false

    async function loadTrails() {
      setLoadingCatalog(true)
      setError('')
      try {
        const response = await fetch('/memex-trails', { cache: 'no-store' })
        if (!response.ok) {
          throw new Error(`Trail catalogue returned ${response.status}`)
        }

        const payload = (await response.json()) as unknown
        const nextTrails = extractTrails(payload)
        if (!cancelled) {
          setTrails(nextTrails)
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Failed to load trail catalogue')
        }
      } finally {
        if (!cancelled) setLoadingCatalog(false)
      }
    }

    void loadTrails()
    return () => {
      cancelled = true
    }
  }, [])


  useEffect(() => {
    const stored = window.localStorage.getItem('memex-trail-overlap-auto-confidence')
    if (!stored) return
    const value = Number(stored)
    if (Number.isFinite(value) && value >= 0 && value <= 1) {
      setAutoSelectConfidence(value)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(
      'memex-trail-overlap-auto-confidence',
      String(autoSelectConfidence),
    )
  }, [autoSelectConfidence])

  useEffect(() => {
    if (!result) {
      setSelectedPairKeys(new Set())
      return
    }

    setSelectedPairKeys(
      new Set(
        result.review.pairwise
          .filter((pair) => isAutoChangeCandidate(pair, autoSelectConfidence))
          .map(pairKey),
      ),
    )
  }, [autoSelectConfidence, result])

  const visibleTrails = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return trails

    return trails.filter((trail) => {
      const memberText = trail.members
        .map((member) => `${member.title ?? ''} ${member.alias}`)
        .join(' ')

      return [
        trail.name,
        trail.reason ?? '',
        trail.origin ?? '',
        trail.status ?? '',
        memberText,
      ]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [query, trails])

  const selectedTrails = useMemo(
    () => trails.filter((trail) => selectedIds.has(trail.id)),
    [selectedIds, trails],
  )

  const selectedPairCount =
    selectedTrails.length < 2
      ? 0
      : (selectedTrails.length * (selectedTrails.length - 1)) / 2

  function toggleTrail(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setResult(null)
    setSelectedPairKeys(new Set())
  }

  async function reviewOverlap() {
    if (selectedTrails.length < 2 || reviewing) return

    setReviewing(true)
    setError('')
    setResult(null)

    try {
      const response = await fetch('/memex-trail-overlap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trails: selectedTrails }),
      })

      const payload = (await response.json()) as
        | ReviewResponse
        | { error?: string }

      if (!response.ok || !('review' in payload)) {
        throw new Error(
          'error' in payload && payload.error
            ? payload.error
            : `Overlap review returned ${response.status}`,
        )
      }

      setResult(payload)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Trail overlap review failed')
    } finally {
      setReviewing(false)
    }
  }

  function clearSelection() {
    setSelectedIds(new Set())
    setResult(null)
    setSelectedPairKeys(new Set())
    setError('')
  }

  function togglePairSelection(pair: PairwiseReview) {
    const key = pairKey(pair)
    setSelectedPairKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const trailName = new Map<string, string>(
    trails.map((trail) => [trail.id, trail.name] as [string, string]),
  )

  function displayTrailName(pair: PairwiseReview, index: 0 | 1): string {
    return (
      pair.trailNames?.[index] ??
      trailName.get(pair.trailIds[index]) ??
      'Selected trail'
    )
  }

  return (
    <section
      data-memex-trail-overlap-review
      style={{
        border: '1px solid var(--bs-border-color, #d8dee4)',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginBottom: '1.5rem',
        background: 'var(--bs-body-bg, #fff)',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: '1rem',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '1.2rem' }}>LLM Trail Overlap Review</h2>
          <p style={{ margin: '0.35rem 0 0', opacity: 0.8 }}>
            Select two or more trails for a separate read-only LLM review. It does not merge,
            rename, edit, or delete trails.
          </p>
        </div>

        <div style={{ whiteSpace: 'nowrap', opacity: 0.75 }}>
          Selected: {selectedIds.size} · pairs to review: {selectedPairCount}
        </div>
      </div>

      <div style={{ marginTop: '0.9rem' }}>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter trails by name, reason, source title, or alias"
          aria-label="Filter trails for overlap review"
          style={{
            width: '100%',
            padding: '0.55rem 0.7rem',
            border: '1px solid var(--bs-border-color, #ced4da)',
            borderRadius: '0.375rem',
            background: 'var(--bs-body-bg, #fff)',
            color: 'inherit',
          }}
        />
      </div>

      <div
        style={{
          marginTop: '0.75rem',
          maxHeight: '20rem',
          overflowY: 'auto',
          border: '1px solid var(--bs-border-color, #e2e6ea)',
          borderRadius: '0.375rem',
        }}
      >
        {loadingCatalog && <div style={{ padding: '0.75rem' }}>Loading trails…</div>}

        {!loadingCatalog && visibleTrails.length === 0 && (
          <div style={{ padding: '0.75rem' }}>No matching trails.</div>
        )}

        {visibleTrails.map((trail) => {
          const checked = selectedIds.has(trail.id)
          return (
            <label
              key={trail.id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto minmax(0, 1fr) auto',
                gap: '0.65rem',
                padding: '0.7rem 0.8rem',
                borderBottom: '1px solid var(--bs-border-color, #eef0f2)',
                cursor: 'pointer',
                background: checked ? 'var(--bs-tertiary-bg, #f1f3f5)' : undefined,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleTrail(trail.id)}
                style={{ marginTop: '0.25rem' }}
              />

              <span style={{ minWidth: 0 }}>
                <strong>{trail.name}</strong>
                {(trail.origin || trail.status) && (
                  <span style={{ marginLeft: '0.5rem', opacity: 0.65 }}>
                    {[trail.origin, trail.status].filter(Boolean).join(' · ')}
                  </span>
                )}
                {trail.reason && (
                  <span
                    style={{
                      display: 'block',
                      marginTop: '0.2rem',
                      opacity: 0.78,
                    }}
                  >
                    {trail.reason}
                  </span>
                )}
              </span>

              <span style={{ opacity: 0.7, whiteSpace: 'nowrap' }}>
                {trail.members.length} members
              </span>
            </label>
          )
        })}
      </div>

      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: '0.8rem',
          padding: '0.65rem 0.75rem',
          border: '1px solid var(--bs-border-color, #dee2e6)',
          borderRadius: '0.375rem',
        }}
      >
        <label htmlFor='memex-overlap-auto-confidence'>
          <strong>Auto-select change candidates at confidence</strong>
        </label>
        <input
          id='memex-overlap-auto-confidence'
          type='number'
          min={0}
          max={100}
          step={5}
          value={Math.round(autoSelectConfidence * 100)}
          onChange={(event) => {
            const next = Number(event.target.value)
            if (!Number.isFinite(next)) return
            setAutoSelectConfidence(Math.max(0, Math.min(100, next)) / 100)
          }}
          aria-label='Automatic overlap change confidence threshold'
          style={{
            width: '5.5rem',
            padding: '0.4rem 0.5rem',
            border: '1px solid var(--bs-border-color, #ced4da)',
            borderRadius: '0.375rem',
            background: 'var(--bs-body-bg, #fff)',
            color: 'inherit',
          }}
        />
        <span>%</span>
        <span style={{ opacity: 0.7 }}>
          After each LLM review, strong-overlap/duplicate pairs at or above this level are
          ticked automatically. Change the level to recalculate the ticks from the current
          results.
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginTop: '0.8rem',
        }}
      >
        <button
          type="button"
          onClick={() => void reviewOverlap()}
          disabled={selectedTrails.length < 2 || reviewing}
          style={{
            padding: '0.5rem 0.8rem',
            borderRadius: '0.375rem',
            border: '1px solid #0d6efd',
            background: selectedTrails.length < 2 || reviewing ? '#6c757d' : '#0d6efd',
            color: '#fff',
            cursor: selectedTrails.length < 2 || reviewing ? 'not-allowed' : 'pointer',
          }}
        >
          {reviewing ? 'Reviewing overlap…' : 'Review overlap with LLM'}
        </button>

        <button
          type="button"
          onClick={clearSelection}
          disabled={selectedIds.size === 0 && !result}
          style={{
            padding: '0.5rem 0.8rem',
            borderRadius: '0.375rem',
            border: '1px solid var(--bs-border-color, #adb5bd)',
            background: 'var(--bs-body-bg, #fff)',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          Clear
        </button>

        {selectedTrails.length === 1 && (
          <span style={{ opacity: 0.7 }}>Select one more trail.</span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          style={{
            marginTop: '0.9rem',
            padding: '0.7rem',
            border: '1px solid #dc3545',
            borderRadius: '0.375rem',
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop: '1rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--bs-border-color, #dee2e6)',
          }}
        >
          <div
            style={{
              display: 'flex',
              gap: '0.7rem',
              alignItems: 'baseline',
              flexWrap: 'wrap',
            }}
          >
            <strong style={{ textTransform: 'capitalize' }}>
              {displayClassification(result.review.classification)}
            </strong>
            <span style={{ opacity: 0.7 }}>
              confidence {confidencePercent(result.review.confidence)}
            </span>
            <span style={{ opacity: 0.7 }}>model {result.model}</span>
            <span style={{ opacity: 0.7 }}>
              reviewed {result.reviewedPairCount}/{result.expectedPairCount} pairs
            </span>
            {result.repairCalls > 0 && (
              <span style={{ opacity: 0.7 }}>completed with {result.repairCalls} repair call(s)</span>
            )}
            <span style={{ opacity: 0.7 }}>
              auto-selected {selectedPairKeys.size} at ≥ {confidencePercent(autoSelectConfidence)}
            </span>
          </div>

          {result.review.summary && <p>{result.review.summary}</p>}

          {result.review.recommendation && (
            <p>
              <strong>Recommendation:</strong> {result.review.recommendation}
            </p>
          )}

          {result.review.distinctions.length > 0 && (
            <div>
              <strong>Important distinctions</strong>
              <ul>
                {result.review.distinctions.map((distinction, index) => (
                  <li key={`${index}-${distinction}`}>{distinction}</li>
                ))}
              </ul>
            </div>
          )}

          {result.review.pairwise.length > 0 && (
            <div>
              <strong>Pairwise review</strong>
              <div style={{ display: 'grid', gap: '0.6rem', marginTop: '0.5rem' }}>
                {result.review.pairwise.map((pair, index) => (
                  <div
                    key={`${pair.trailIds.join('-')}-${index}`}
                    style={{
                      border: '1px solid var(--bs-border-color, #dee2e6)',
                      borderRadius: '0.375rem',
                      padding: '0.7rem',
                    }}
                  >
                    <label
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'auto minmax(0, 1fr)',
                        gap: '0.6rem',
                        alignItems: 'start',
                        cursor: 'pointer',
                      }}
                    >
                      <input
                        type='checkbox'
                        checked={selectedPairKeys.has(pairKey(pair))}
                        onChange={() => togglePairSelection(pair)}
                        aria-label={`Select overlap recommendation for ${
                          displayTrailName(pair, 0)
                        } and ${displayTrailName(pair, 1)}`}
                        style={{ marginTop: '0.25rem' }}
                      />
                      <span>
                        <strong>
                          {displayTrailName(pair, 0)}
                        </strong>
                        {' ↔ '}
                        <strong>
                          {displayTrailName(pair, 1)}
                        </strong>
                        <span style={{ display: 'block', marginTop: '0.25rem', opacity: 0.75 }}>
                          {displayClassification(pair.classification)} · confidence{' '}
                          {confidencePercent(pair.confidence)}
                          {isAutoChangeCandidate(pair, autoSelectConfidence) &&
                            selectedPairKeys.has(pairKey(pair)) &&
                            ' · auto-selected'}
                        </span>
                      </span>
                    </label>
                    {pair.overlap && (
                      <p style={{ marginBottom: '0.35rem' }}>
                        <strong>Overlap:</strong> {pair.overlap}
                      </p>
                    )}
                    {pair.distinction && (
                      <p style={{ marginBottom: '0.35rem' }}>
                        <strong>Distinction:</strong> {pair.distinction}
                      </p>
                    )}
                    {pair.recommendation && (
                      <p style={{ marginBottom: 0 }}>
                        <strong>Recommendation:</strong> {pair.recommendation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <p style={{ marginBottom: 0, marginTop: '0.8rem', opacity: 0.7 }}>
            Read-only review: no trail state was changed. Confidence only auto-selects/ticks
            recommendations from the current review; it does not automatically write trail
            changes.
          </p>
        </div>
      )}
    </section>
  )
}
