'use client'

import type { NoteExploreEntryInterface, NoteType, SortMode } from '@hedgedoc/commons'
import React, { useCallback, useState } from 'react'
import { Alert, Button, Dropdown, Form, Modal, Spinner } from 'react-bootstrap'
import { getExplorePageEntries } from '../../../../api/explore'
import { Mode } from '../../mode-selection/mode'

interface DraftTrail {
  id: string
  name: string
  reason: string
  memberCount: number
}

interface Props {
  mode: Mode
  sort: SortMode
  searchFilter: string | null
  typeFilter: NoteType | null
  asMenuItem?: boolean
  onOpen?: () => void
}

export const BatchUserTrailButton: React.FC<Props> = ({
  mode,
  sort,
  searchFilter,
  typeFilter,
  asMenuItem = false,
  onOpen
}) => {
  const [show, setShow] = useState(false)
  const [drafts, setDrafts] = useState<DraftTrail[]>([])
  const [trailId, setTrailId] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const open = useCallback(async () => {
    onOpen?.()
    setShow(true)
    setMessage('')
    setError('')

    try {
      const response = await fetch('/memex-batch-user-trail', {
        cache: 'no-store'
      })

      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }

      const items = body.trails ?? []
      setDrafts(items)

      if (items.length === 1) {
        setTrailId(items[0].id)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load drafts')
    }
  }, [onOpen])

  const apply = useCallback(async () => {
    if (!trailId) return

    setBusy(true)
    setError('')
    setMessage('Loading all notes matching the current Explore filter…')

    try {
      const found = new Map<string, NoteExploreEntryInterface>()

      for (let page = 1; page <= 10000; page += 1) {
        const entries = await getExplorePageEntries(
          mode,
          sort,
          searchFilter,
          typeFilter,
          page
        )

        if (entries.length === 0) break

        for (const note of entries) {
          found.set(note.primaryAlias, note)
        }
      }

      const notes = [...found.values()].map((note) => ({
        alias: note.primaryAlias,
        title: note.title
      }))

      if (notes.length === 0) {
        throw new Error('Current Explore filter matches no notes')
      }

      setMessage(`Updating ${notes.length} filtered note(s)…`)

      const response = await fetch('/memex-batch-user-trail', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          trailId,
          notes
        })
      })

      const body = await response.json()

      if (!response.ok) {
        throw new Error(body.error ?? `HTTP ${response.status}`)
      }

      setMessage(
        `Added ${body.updated} note(s) to "${body.trailName}" using tag "${body.tag}"` +
          (body.failed ? `; ${body.failed} failed.` : '.')
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch update failed')
      setMessage('')
    } finally {
      setBusy(false)
    }
  }, [trailId, mode, sort, searchFilter, typeFilter])

  return (
    <>
      {asMenuItem ? (
        <Dropdown.Item onClick={open}>Batch User Trail</Dropdown.Item>
      ) : (
        <Button size='sm' variant='outline-success' onClick={open}>
          Batch User Trail
        </Button>
      )}

      <Modal show={show} onHide={() => !busy && setShow(false)}>
        <Modal.Header closeButton={!busy}>
          <Modal.Title>Batch User Trail</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          <p>
            Add every note matching the current <strong>My Notes</strong>{' '}
            filters to a draft user trail.
          </p>

          <div className='small text-muted mb-3'>
            Search: <strong>{searchFilter || 'all'}</strong>
            <br />
            Type: <strong>{typeFilter || 'all'}</strong>
          </div>

          {drafts.length === 0 && !error && (
            <Alert variant='warning'>
              No draft user trails. Create one in User Trails first.
            </Alert>
          )}

          {drafts.length > 0 && (
            <Form.Select
              value={trailId}
              disabled={busy}
              onChange={(event) => setTrailId(event.target.value)}>
              <option value=''>Select draft user trail…</option>

              {drafts.map((trail) => (
                <option key={trail.id} value={trail.id}>
                  {trail.name} ({trail.memberCount} members)
                </option>
              ))}
            </Form.Select>
          )}

          {message && <Alert variant='success' className='mt-3'>{message}</Alert>}
          {error && <Alert variant='danger' className='mt-3'>{error}</Alert>}
        </Modal.Body>

        <Modal.Footer>
          <Button
            variant='secondary'
            disabled={busy}
            onClick={() => setShow(false)}>
            Close
          </Button>

          <Button
            variant='success'
            disabled={busy || !trailId}
            onClick={apply}>
            {busy && <Spinner size='sm' className='me-2' />}
            Add Filtered Notes
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  )
}
