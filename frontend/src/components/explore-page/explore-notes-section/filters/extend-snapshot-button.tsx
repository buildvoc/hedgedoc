'use client'

import type { RevisionMetadataInterface } from '@hedgedoc/commons'
import React, { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Dropdown, Form, Modal, Spinner } from 'react-bootstrap'

interface SelectedSnapshotNote {
  alias: string
  title: string
}

interface SnapshotExtendCandidate {
  alias: string
  title: string
}

interface SnapshotExtendOptions {
  baseRevision: string
  baseName: string
  baseSourceCount: number
  candidates: SnapshotExtendCandidate[]
}

interface IndexedMemexSourcesResponse {
  sources: SnapshotExtendCandidate[]
}

interface Props {
  selectedNotes: SelectedSnapshotNote[]
  onClearSelection: () => void
  asMenuItem?: boolean
}

const loadSnapshotRevisions = async (): Promise<RevisionMetadataInterface[]> => {
  const response = await fetch('/memex-revisions/memex-snapshots', {
    cache: 'no-store'
  })

  if (!response.ok) {
    throw new Error(`Failed to load snapshot revisions (${response.status})`)
  }

  return (await response.json()) as RevisionMetadataInterface[]
}

const loadSnapshotOptions = async (baseRevision: string): Promise<SnapshotExtendOptions> => {
  const response = await fetch(
    `/memex-snapshot?baseRevision=${encodeURIComponent(baseRevision)}`,
    { cache: 'no-store' }
  )
  const body = (await response.json().catch(() => ({}))) as SnapshotExtendOptions & {
    error?: string
  }

  if (!response.ok) {
    throw new Error(body.error || `Failed to inspect snapshot revision (${response.status})`)
  }

  return body
}

const loadIndexedMemexSources = async (): Promise<SnapshotExtendCandidate[]> => {
  const response = await fetch('/memex-snapshot?indexed=1', { cache: 'no-store' })
  const body = (await response.json().catch(() => ({}))) as IndexedMemexSourcesResponse & {
    error?: string
  }

  if (!response.ok) {
    throw new Error(body.error || `Failed to load indexed Memex sources (${response.status})`)
  }

  return Array.isArray(body.sources) ? body.sources : []
}

export const ExtendSnapshotButton: React.FC<Props> = ({
  selectedNotes,
  onClearSelection,
  asMenuItem = false
}) => {
  const [show, setShow] = useState(false)
  const [revisions, setRevisions] = useState<RevisionMetadataInterface[]>([])
  const [indexedAliases, setIndexedAliases] = useState<Set<string>>(new Set())
  const [baseRevision, setBaseRevision] = useState('')
  const [options, setOptions] = useState<SnapshotExtendOptions>()
  const [snapshotName, setSnapshotName] = useState('')
  const [busy, setBusy] = useState(false)
  const [loadingRevision, setLoadingRevision] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const indexedSelectedNotes = useMemo(
    () => selectedNotes.filter((note) => indexedAliases.has(note.alias)),
    [indexedAliases, selectedNotes]
  )

  const nonIndexedSelectedNotes = useMemo(
    () => selectedNotes.filter((note) => !indexedAliases.has(note.alias)),
    [indexedAliases, selectedNotes]
  )

  const eligibleNotes = useMemo(() => {
    if (!options) return []
    const candidateAliases = new Set(options.candidates.map((candidate) => candidate.alias))
    return indexedSelectedNotes.filter((note) => candidateAliases.has(note.alias))
  }, [indexedSelectedNotes, options])

  const alreadyInBaseNotes = useMemo(() => {
    if (!options) return []
    const eligibleAliases = new Set(eligibleNotes.map((note) => note.alias))
    return indexedSelectedNotes.filter((note) => !eligibleAliases.has(note.alias))
  }, [eligibleNotes, indexedSelectedNotes, options])

  const open = useCallback(async () => {
    setShow(true)
    setError('')
    setMessage('')
    setIndexedAliases(new Set())
    setBaseRevision('')
    setOptions(undefined)
    setSnapshotName('')

    try {
      const [loadedRevisions, indexedSources] = await Promise.all([
        loadSnapshotRevisions(),
        loadIndexedMemexSources(),
      ])
      setRevisions(
        [...loadedRevisions].sort(
          (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)
        )
      )
      setIndexedAliases(new Set(indexedSources.map((source) => source.alias)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load snapshot extension data')
    }
  }, [])

  const selectBaseRevision = useCallback(async (revisionId: string) => {
    setBaseRevision(revisionId)
    setOptions(undefined)
    setSnapshotName('')
    setMessage('')
    setError('')

    if (!revisionId) return

    setLoadingRevision(true)
    try {
      const loaded = await loadSnapshotOptions(revisionId)
      setOptions(loaded)
      const candidateAliases = new Set(loaded.candidates.map((candidate) => candidate.alias))
      const eligibleCount = indexedSelectedNotes.filter((note) => candidateAliases.has(note.alias)).length
      setSnapshotName(
        `${loaded.baseName} + ${eligibleCount} HedgeDoc${eligibleCount === 1 ? '' : 's'}`.slice(
          0,
          120
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect snapshot revision')
    } finally {
      setLoadingRevision(false)
    }
  }, [indexedSelectedNotes])

  const extendSnapshot = useCallback(async () => {
    if (!baseRevision || !options || eligibleNotes.length === 0 || !snapshotName.trim()) return

    setBusy(true)
    setMessage('')
    setError('')

    try {
      const response = await fetch('/memex-snapshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: snapshotName.trim(),
          baseRevision,
          sourceAliases: eligibleNotes.map((note) => note.alias)
        })
      })
      const body = (await response.json().catch(() => ({}))) as {
        created?: boolean
        error?: string
        sourceCount?: number
        snapshotRevision?: string
      }

      if (!response.ok || !body.created) {
        throw new Error(body.error || `Snapshot extension failed (${response.status})`)
      }

      setMessage(
        `Created derived snapshot with ${body.sourceCount ?? options.baseSourceCount + eligibleNotes.length} sources.`
      )
      onClearSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extend snapshot')
    } finally {
      setBusy(false)
    }
  }, [baseRevision, eligibleNotes, onClearSelection, options, snapshotName])

  const close = () => {
    if (!busy) setShow(false)
  }

  const disabled = selectedNotes.length === 0
  const label = `Extend Snapshot${selectedNotes.length > 0 ? ` (${selectedNotes.length})` : ''}`

  return (
    <>
      {asMenuItem ? (
        <Dropdown.Item disabled={disabled} onClick={() => void open()}>
          {label}
        </Dropdown.Item>
      ) : (
        <Button size='sm' variant='outline-primary' disabled={disabled} onClick={() => void open()}>
          {label}
        </Button>
      )}

      <Modal show={show} onHide={close} size='lg'>
        <Modal.Header closeButton={!busy}>
          <Modal.Title>Extend Snapshot</Modal.Title>
        </Modal.Header>

        <Modal.Body>
          <p>
            Create a new snapshot from an existing frozen revision plus the HedgeDocs
            selected on <strong>My Notes</strong>. Only notes in the current indexed Memex source
            set are eligible. Existing source revision UUIDs stay unchanged; each added HedgeDoc is
            frozen at its current revision.
          </p>

          <Alert variant='secondary'>
            Selected notes: <strong>{selectedNotes.length}</strong>
            <br />
            Current indexed Memex sources selected: <strong>{indexedSelectedNotes.length}</strong>
          </Alert>

          {nonIndexedSelectedNotes.length > 0 && (
            <Alert variant='warning'>
              {nonIndexedSelectedNotes.length} selected note{nonIndexedSelectedNotes.length === 1 ? '' : 's'}
              {' '}filtered out because {nonIndexedSelectedNotes.length === 1 ? 'it is' : 'they are'} not in the
              current indexed Memex source set.
            </Alert>
          )}

          <Form.Group className='mb-3'>
            <Form.Label>Base snapshot revision</Form.Label>
            <Form.Select
              value={baseRevision}
              disabled={busy || loadingRevision}
              onChange={(event) => void selectBaseRevision(event.target.value)}>
              <option value=''>Select a frozen snapshot revision…</option>
              {revisions.map((revision) => (
                <option key={revision.uuid} value={revision.uuid}>
                  {new Date(revision.createdAt).toLocaleString()} — {revision.uuid}
                </option>
              ))}
            </Form.Select>
          </Form.Group>

          {loadingRevision && (
            <div className='mb-3'>
              <Spinner size='sm' className='me-2' />
              Reading frozen snapshot…
            </div>
          )}

          {options && (
            <>
              <Alert variant={eligibleNotes.length > 0 ? 'info' : 'warning'}>
                Base: <strong>{options.baseName}</strong> ({options.baseSourceCount} frozen sources)
                <br />
                Eligible selected additions: <strong>{eligibleNotes.length}</strong>
                <br />
                New source count: <strong>{options.baseSourceCount + eligibleNotes.length}</strong>
              </Alert>

              {alreadyInBaseNotes.length > 0 && (
                <Alert variant='warning'>
                  {alreadyInBaseNotes.length} indexed Memex source{alreadyInBaseNotes.length === 1 ? '' : 's'}
                  {' '}filtered out because {alreadyInBaseNotes.length === 1 ? 'it is' : 'they are'} already
                  present in the selected base snapshot.
                </Alert>
              )}

              <Form.Group className='mb-3'>
                <Form.Label>New snapshot name</Form.Label>
                <Form.Control
                  value={snapshotName}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setSnapshotName(event.target.value)}
                />
              </Form.Group>

              {eligibleNotes.length > 0 && (
                <div className='small mb-3'>
                  <strong>Will add:</strong>
                  <ul className='mb-0 mt-1'>
                    {eligibleNotes.map((note) => (
                      <li key={note.alias}>{note.title || note.alias}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {message && <Alert variant='success'>{message}</Alert>}
          {error && <Alert variant='danger'>{error}</Alert>}
        </Modal.Body>

        <Modal.Footer>
          <Button variant='secondary' disabled={busy} onClick={close}>
            Close
          </Button>
          <Button
            variant='primary'
            disabled={
              busy ||
              loadingRevision ||
              !baseRevision ||
              !options ||
              eligibleNotes.length === 0 ||
              !snapshotName.trim()
            }
            onClick={() => void extendSnapshot()}>
            {busy && <Spinner size='sm' className='me-2' />}
            Create Derived Snapshot
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  )
}
