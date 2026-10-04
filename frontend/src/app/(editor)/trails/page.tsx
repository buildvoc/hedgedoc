'use client'

// MEMEX_TRAIL_OVERLAP_REVIEW_IMPORT
import { TrailOverlapReview } from './trail-overlap-review'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  ButtonGroup,
  Container,
  Form,
  Spinner
} from 'react-bootstrap'
import { FilterBySearchTerm } from '../../../components/explore-page/explore-notes-section/filters/filter-by-search-term'
import { useUrlParamState } from '../../../hooks/common/use-url-param-state'

interface Member {
  alias: string
  title: string
}

interface Trail {
  id: string
  recordId?: string
  name: string
  reason: string
  origin: 'system' | 'user'
  status?: 'draft' | 'integrated'
  members: Member[]
}

interface GraphResponse {
  trails: Trail[]
  systemCount: number
  userCount: number
}

const TRAIL_X = 230
const SOURCE_X = 820
const ROW_HEIGHT = 82

export default function TrailsPage() {
  const [data, setData] = useState<GraphResponse | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSystem, setShowSystem] = useState(true)
  const [showUser, setShowUser] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [searchFilter, setSearchFilter] =
    useUrlParamState<string | null>('search', null)

  const load = useCallback(async () => {
    const response = await fetch('/memex-trails?includeDrafts=1', {
      cache: 'no-store'
    })
    const body = await response.json()

    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
    setData(body as GraphResponse)
  }, [])

  useEffect(() => {
    void load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Failed to load trails')
    )
  }, [load])

  const drafts =
    data?.trails.filter(
      (trail) => trail.origin === 'user' && trail.status === 'draft'
    ) ?? []

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function integrate() {
    if (selected.size === 0) return

    setBusy(true)
    setError('')
    setMessage('')

    try {
      const response = await fetch('/memex-trails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'integrate',
          ids: [...selected]
        })
      })

      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }

      setSelected(new Set())
      setMessage(`${body.integrated} user trail(s) integrated into nodeBook.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Integration failed')
    } finally {
      setBusy(false)
    }
  }

  const graph = useMemo(() => {
    if (!data) return null

    const query = (searchFilter ?? '').trim().toLowerCase()

    const trails = data.trails.filter((trail) => {
      const visible =
        (trail.origin === 'system' && showSystem) ||
        (trail.origin === 'user' && showUser)

      if (!visible) return false
      if (!query) return true

      return [
        trail.name,
        trail.reason,
        trail.origin,
        trail.status ?? '',
        ...trail.members.flatMap((member) => [member.title, member.alias])
      ]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })

    const sources = new Map<string, Member>()

    for (const trail of trails) {
      for (const member of trail.members) sources.set(member.alias, member)
    }

    const sourceList = [...sources.values()].sort((a, b) =>
      a.title.localeCompare(b.title)
    )

    return {
      trails,
      sources: sourceList,
      trailY: new Map(trails.map((trail, i) => [trail.id, 55 + i * ROW_HEIGHT])),
      sourceY: new Map(
        sourceList.map((source, i) => [source.alias, 55 + i * ROW_HEIGHT])
      ),
      height: Math.max(trails.length, sourceList.length, 1) * ROW_HEIGHT + 60
    }
  }, [data, showSystem, showUser, searchFilter])

  return (
    <Container fluid className='py-4 px-4'>
    {/* MEMEX_TRAIL_OVERLAP_REVIEW */}
    <TrailOverlapReview />
      <div className='d-flex flex-wrap align-items-center justify-content-between gap-3 mb-3'>
        <div>
          <h1 className='mb-1'>Trail Graph</h1>
          <div className='text-muted'>
            Memex trails and user-created trails.
          </div>
        </div>

        <div className='d-flex flex-wrap align-items-center gap-2'>
          <FilterBySearchTerm
            value={searchFilter}
            onChange={setSearchFilter}
          />

          <ButtonGroup>
            <Button
              variant={showSystem ? 'primary' : 'outline-primary'}
              onClick={() => setShowSystem((value) => !value)}>
              Existing
            </Button>

            <Button
              variant={showUser ? 'success' : 'outline-success'}
              onClick={() => setShowUser((value) => !value)}>
              User Trails
            </Button>
          </ButtonGroup>
        </div>
      </div>

      {drafts.length > 0 && (
        <div className='border rounded p-3 mb-3'>
          <div className='d-flex flex-wrap justify-content-between gap-3'>
            <div>
              <strong>Draft User Trails</strong>

              {drafts.map((trail) => (
                <Form.Check
                  key={trail.recordId}
                  className='mt-2'
                  type='checkbox'
                  checked={Boolean(trail.recordId && selected.has(trail.recordId))}
                  label={trail.name}
                  onChange={() => trail.recordId && toggle(trail.recordId)}
                />
              ))}
            </div>

            <div>
              <Button
                variant='success'
                disabled={busy || selected.size === 0}
                onClick={integrate}>
                {busy && <Spinner size='sm' className='me-2' />}
                Integrate Selected ({selected.size})
              </Button>
            </div>
          </div>
        </div>
      )}

      {message && <Alert variant='success'>{message}</Alert>}
      {error && <Alert variant='danger'>{error}</Alert>}
      {!data && !error && <Spinner animation='border' />}

      <div className='d-flex gap-4 mb-3 small'>
        <span><Badge bg='primary'>Memex trail</Badge></span>
        <span><Badge bg='success'>Integrated user trail</Badge></span>
        <span style={{ background: '#75b798', color: 'white', padding: '2px 7px', borderRadius: 4 }}>
          Draft user trail
        </span>
        <span><Badge bg='secondary'>HedgeDoc source</Badge></span>
      </div>

      {graph && graph.trails.length > 0 && (
        <div
          className='border rounded bg-body overflow-auto'
          style={{ maxHeight: '75vh' }}>
          <svg width='1120' height={graph.height}>
            {graph.trails.flatMap((trail) =>
              trail.members.map((member) => {
                const y1 = graph.trailY.get(trail.id)
                const y2 = graph.sourceY.get(member.alias)
                if (y1 === undefined || y2 === undefined) return null

                const draft =
                  trail.origin === 'user' && trail.status === 'draft'

                return (
                  <line
                    key={`${trail.id}-${member.alias}`}
                    x1={TRAIL_X + 145}
                    y1={y1}
                    x2={SOURCE_X - 145}
                    y2={y2}
                    stroke={
                      trail.origin === 'system'
                        ? '#0d6efd'
                        : draft
                          ? '#75b798'
                          : '#198754'
                    }
                    strokeWidth={trail.origin === 'user' ? 3 : 2}
                    opacity={0.5}
                  />
                )
              })
            )}

            {graph.trails.map((trail) => {
              const y = graph.trailY.get(trail.id) ?? 0
              const draft =
                trail.origin === 'user' && trail.status === 'draft'

              const fill =
                trail.origin === 'system'
                  ? '#0d6efd'
                  : draft
                    ? '#75b798'
                    : '#198754'

              return (
                <g key={trail.id}>
                  <rect
                    x={TRAIL_X - 145}
                    y={y - 25}
                    width='290'
                    height='50'
                    rx='10'
                    fill={fill}
                  />
                  <text
                    x={TRAIL_X}
                    y={y - 2}
                    textAnchor='middle'
                    fill='white'
                    fontWeight='600'
                    fontSize='14'>
                    {trail.name.length > 34
                      ? `${trail.name.slice(0, 31)}…`
                      : trail.name}
                  </text>
                  <text
                    x={TRAIL_X}
                    y={y + 16}
                    textAnchor='middle'
                    fill='white'
                    fontSize='11'>
                    {trail.origin === 'system'
                      ? 'MEMEX TRAIL'
                      : draft
                        ? 'USER DRAFT'
                        : 'USER INTEGRATED'}
                  </text>
                  <title>{trail.reason}</title>
                </g>
              )
            })}

            {graph.sources.map((source) => {
              const y = graph.sourceY.get(source.alias) ?? 0

              return (
                <a
                  key={source.alias}
                  href={`/n/${encodeURIComponent(source.alias)}`}>
                  <g style={{ cursor: 'pointer' }}>
                    <rect
                      x={SOURCE_X - 145}
                      y={y - 24}
                      width='290'
                      height='48'
                      rx='8'
                      fill='#6c757d'
                    />
                    <text
                      x={SOURCE_X}
                      y={y + 5}
                      textAnchor='middle'
                      fill='white'
                      fontSize='13'>
                      {source.title.length > 38
                        ? `${source.title.slice(0, 35)}…`
                        : source.title}
                    </text>
                  </g>
                </a>
              )
            })}
          </svg>
        </div>
      )}
    </Container>
  )
}
