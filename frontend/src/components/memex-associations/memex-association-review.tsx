'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Spinner } from 'react-bootstrap'

interface AssociationRecommendation {
  id: string
  source: string
  sourceTitle?: string
  target: string
  targetTitle?: string
  reason: string
  confidence: number
  mainModel?: string
  recommendationSource?: string
  sourceRevision?: string
  snapshotRevision?: string
  recommendedAt: string
  status: 'pending' | 'accepted' | 'rejected' | 'superseded'
  reviewedAt?: string
  canonicalAction?: string
}

interface RecommendationsResponse {
  items?: AssociationRecommendation[]
  pendingCount?: number
  error?: string
}

export const MemexAssociationReview: React.FC = () => {
  const [items, setItems] = useState<AssociationRecommendation[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch('/memex-association-recommendations?status=pending', {
        cache: 'no-store',
      })
      const payload = (await response.json()) as RecommendationsResponse
      if (!response.ok) {
        throw new Error(payload.error || `Recommendations HTTP ${response.status}`)
      }
      setItems(payload.items ?? [])
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Unable to load association recommendations',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const review = async (id: string, action: 'accept' | 'reject') => {
    setBusyId(id)
    setMessage('')
    setError('')

    try {
      const response = await fetch('/memex-association-recommendations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      const payload = (await response.json()) as {
        canonicalAction?: string
        error?: string
      }
      if (!response.ok) {
        throw new Error(payload.error || `Review HTTP ${response.status}`)
      }

      setMessage(
        action === 'accept'
          ? `Accepted. Canonical action: ${payload.canonicalAction ?? 'updated'}.`
          : 'Rejected. Canonical associations were not changed.',
      )
      await load()
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Unable to review association recommendation',
      )
    } finally {
      setBusyId('')
    }
  }

  if (loading) {
    return (
      <div className='d-flex align-items-center gap-2'>
        <Spinner animation='border' size='sm' /> Loading recommendations…
      </div>
    )
  }

  return (
    <div>
      {error && <Alert variant='warning'>{error}</Alert>}
      {message && <Alert variant='success'>{message}</Alert>}

      {items.length === 0 ? (
        <Alert variant='secondary'>No association suggestions await human review.</Alert>
      ) : (
        <div className='d-grid gap-3'>
          {items.map((item) => (
            <Card key={item.id}>
              <Card.Body>
                <div className='d-flex flex-wrap align-items-start justify-content-between gap-2'>
                  <div>
                    <h2 className='h5 mb-1'>
                      <a href={`/n/${item.source}`} target='_blank' rel='noreferrer'>
                        {item.sourceTitle || item.source}
                      </a>{' '}
                      ↔{' '}
                      <a href={`/n/${item.target}`} target='_blank' rel='noreferrer'>
                        {item.targetTitle || item.target}
                      </a>
                    </h2>
                    <div className='text-muted small'>
                      {item.source} ↔ {item.target}
                    </div>
                  </div>
                  <Badge bg='info'>
                    {(Number(item.confidence || 0) * 100).toFixed(0)}% model confidence
                  </Badge>
                </div>

                <p className='mt-3 mb-2'>{item.reason}</p>

                <div className='small text-muted mb-3'>
                  Suggested by: <code>{item.mainModel || 'unknown model'}</code>
                  {' · '}Human verification required
                  {' · '}Suggested: {item.recommendedAt}
                </div>

                <div className='d-flex flex-wrap gap-2'>
                  <Button
                    disabled={busyId === item.id}
                    onClick={() => void review(item.id, 'accept')}
                    variant='success'
                  >
                    {busyId === item.id ? 'Working…' : 'Accept association'}
                  </Button>
                  <Button
                    disabled={busyId === item.id}
                    onClick={() => void review(item.id, 'reject')}
                    variant='outline-danger'
                  >
                    Reject
                  </Button>
                </div>
              </Card.Body>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
