'use client'

import React, { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Form,
  Spinner
} from 'react-bootstrap'

interface Member {
  alias: string
  title: string
}

interface TrailOption {
  name: string
  reason: string
  members: Member[]
}

interface Analysis {
  existingMatch: {
    name: string
    reason: string
  } | null
  options: TrailOption[]
}

export default function UserTrailsPage() {
  const [expression, setExpression] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [committed, setCommitted] = useState<string | null>(null)

  async function analyze() {
    setBusy(true)
    setError('')
    setCommitted(null)
    setAnalysis(null)
    setSelected(null)

    try {
      const response = await fetch('/memex-user-trails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'analyze',
          expression
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`)
      }

      setAnalysis(data as Analysis)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Analysis failed')
    } finally {
      setBusy(false)
    }
  }

  async function commit() {
    if (selected === null || !analysis?.options[selected]) return

    setBusy(true)
    setError('')

    try {
      const option = analysis.options[selected]

      const response = await fetch('/memex-user-trails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'commit',
          expression,
          option
        })
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`)
      }

      setCommitted(data.committed.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Commit failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container className='py-4' style={{ maxWidth: 900 }}>
      <h1>User Trails</h1>
      <p className='text-muted'>
        Express a trail in your own words. The LLM first checks the current
        Memex trails. If none match, it proposes two alternatives.
      </p>

      <Card className='mb-4'>
        <Card.Body>
          <Form.Group>
            <Form.Label>What trail do you want to explore?</Form.Label>
            <Form.Control
              as='textarea'
              rows={5}
              value={expression}
              placeholder='Example: I want a trail connecting local Arts and Crafts architecture with the people and landscapes that shaped it.'
              onChange={(event) => setExpression(event.target.value)}
            />
          </Form.Group>

          <Button
            className='mt-3'
            disabled={busy || expression.trim().length < 8}
            onClick={analyze}>
            {busy && <Spinner size='sm' className='me-2' />}
            Check Trails with LLM
          </Button>
        </Card.Body>
      </Card>

      {error && <Alert variant='danger'>{error}</Alert>}

      {analysis?.existingMatch && (
        <Alert variant='info'>
          <Badge bg='info' className='me-2'>
            Existing trail
          </Badge>
          <strong>{analysis.existingMatch.name}</strong>
          <div className='mt-2'>{analysis.existingMatch.reason}</div>
        </Alert>
      )}

      {analysis && !analysis.existingMatch && (
        <>
          <h2 className='h4'>Choose a trail</h2>

          {analysis.options.map((option, index) => (
            <Card
              key={`${option.name}-${index}`}
              className='mb-3'
              role='button'
              onClick={() => setSelected(index)}>
              <Card.Body>
                <Form.Check
                  type='radio'
                  name='trail-option'
                  checked={selected === index}
                  onChange={() => setSelected(index)}
                  label={<strong>{option.name}</strong>}
                />

                <p className='mt-2 mb-2'>{option.reason}</p>

                <div>
                  {option.members.map((member) => (
                    <Badge
                      bg='secondary'
                      className='me-1 mb-1'
                      key={member.alias}>
                      {member.title}
                    </Badge>
                  ))}
                </div>
              </Card.Body>
            </Card>
          ))}

          <Button
            variant='success'
            disabled={busy || selected === null || Boolean(committed)}
            onClick={commit}>
            Save Draft User Trail
          </Button>
        </>
      )}

      {committed && (
        <Alert variant='success' className='mt-4'>
          <strong>User trail saved as draft.</strong>
          <br />
          Status: <Badge bg='success'>draft</Badge>
          <br />
          <small>{committed}</small>
        </Alert>
      )}
    </Container>
  )
}
