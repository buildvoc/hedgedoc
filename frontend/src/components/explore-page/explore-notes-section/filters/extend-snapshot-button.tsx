'use client'

import type { RevisionMetadataInterface } from '@hedgedoc/commons'
import React, { useCallback, useMemo, useState } from 'react'
import { Alert, Button, Dropdown, Form, Modal, Spinner } from 'react-bootstrap'

interface SelectedSnapshotNote {
  alias: string
  title: string
  tags?: string[]
}

interface SnapshotExtendCandidate {
  alias: string
  title: string
}

interface SnapshotExtendOptions {
  baseRevision: string
  baseName: string
  baseSourceCount: number
  baseSourceAliases: string[]
  candidates: SnapshotExtendCandidate[]
  goldReferences?: { alias: string }[]
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

  const selectedGoldNotes = useMemo(
    () => selectedNotes.filter((note) =>
      note.alias.toLowerCase().startsWith('memex-gold-summary-') ||
      (note.tags ?? []).some((tag) => tag.toLowerCase() === 'memex-gold-summary')
    ),
    [selectedNotes]
  )

  // A frozen snapshot may include original HedgeDocs which have not been put
  // into the Memex index or queue. Gold notes are explicitly excluded.
  const originalSelectedNotes = useMemo(() => {
    const goldAliases = new Set(selectedGoldNotes.map((note) => note.alias))
    return selectedNotes.filter((note) => !goldAliases.has(note.alias))
  }, [selectedNotes, selectedGoldNotes])

  const indexedSelectedNotes = useMemo(
    () => originalSelectedNotes.filter((note) => indexedAliases.has(note.alias)),
    [indexedAliases, originalSelectedNotes]
  )

  const nonIndexedSelectedNotes = useMemo(
    () => originalSelectedNotes.filter((note) => !indexedAliases.has(note.alias)),
    [indexedAliases, originalSelectedNotes]
  )

  const eligibleNotes = useMemo(() => {
    if (!options) return []
    const existing = new Set(options.baseSourceAliases ?? [])
    return originalSelectedNotes.filter((note) => !existing.has(note.alias))
  }, [originalSelectedNotes, options])

  const eligibleGoldNotes = useMemo(() => {
    if (!options) return []
    const frozenGoldAliases = new Set((options.goldReferences ?? []).map((ref) => ref.alias))
    return selectedGoldNotes.filter((note) => !frozenGoldAliases.has(note.alias))
  }, [options, selectedGoldNotes])

  const alreadyInBaseNotes = useMemo(() => {
    if (!options) return []
    const eligibleAliases = new Set(eligibleNotes.map((note) => note.alias))
    return originalSelectedNotes.filter((note) => !eligibleAliases.has(note.alias))
  }, [eligibleNotes, originalSelectedNotes, options])

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
      const existingAliases = new Set(loaded.baseSourceAliases ?? [])
      const eligibleCount = originalSelectedNotes.filter((note) => !existingAliases.has(note.alias)).length
      const existingGoldAliases = new Set((loaded.goldReferences ?? []).map((ref) => ref.alias))
      const goldCount = selectedGoldNotes.filter((note) => !existingGoldAliases.has(note.alias)).length
      setSnapshotName(
        `${loaded.baseName} + ${eligibleCount} sources + ${goldCount} Gold references`.slice(
          0,
          120
        )
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to inspect snapshot revision')
    } finally {
      setLoadingRevision(false)
    }
  }, [originalSelectedNotes, selectedGoldNotes])

  const extendSnapshot = useCallback(async () => {
    if (!baseRevision || !options || (eligibleNotes.length === 0 && eligibleGoldNotes.length === 0) || !snapshotName.trim()) return

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
          sourceAliases: eligibleNotes.map((note) => note.alias),
          goldReferenceAliases: eligibleGoldNotes.map((note) => note.alias)
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
        `Created derived snapshot with ${body.sourceCount ?? options.baseSourceCount + eligibleNotes.length} original sources and frozen Gold references.`
      )
      onClearSelection()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extend snapshot')
    } finally {
      setBusy(false)
    }
  }, [baseRevision, eligibleNotes, eligibleGoldNotes, onClearSelection, options, snapshotName])

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
            selected on <strong>My Notes</strong>. Original sources must be indexed.
            Gold notes marked with the <code>memex-gold-summary</code> tag or
            <code>memex-gold-summary-</code> alias are attached separately as
            frozen benchmark references and never passed to the summary model or Memex queue.
            Unindexed original notes can be frozen without adding them to the index.
            Existing source revisions remain unchanged.
          </p>

          <Alert variant='secondary'>
            Selected notes: <strong>{selectedNotes.length}</strong>
            <br />
            Original sources selected (indexed): <strong>{indexedSelectedNotes.length}</strong>
            <br />
            Original sources selected (not indexed): <strong>{nonIndexedSelectedNotes.length}</strong>
            <br />
            Gold reference notes selected (by tag or alias): <strong>{selectedGoldNotes.length}</strong>
          </Alert>

          {nonIndexedSelectedNotes.length > 0 && (
            <Alert variant='info'>
              {nonIndexedSelectedNotes.length} non-indexed original source{nonIndexedSelectedNotes.length === 1 ? '' : 's'}
              {' '}can be added by freezing their current HedgeDoc revisions.
              They will not be added to the Memex index or queue.
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
              <Alert variant={eligibleNotes.length + eligibleGoldNotes.length > 0 ? 'info' : 'warning'}>
                Base: <strong>{options.baseName}</strong> ({options.baseSourceCount} frozen sources)
                <br />
                Eligible original sources (indexed or not): <strong>{eligibleNotes.length}</strong>
                <br />
                Eligible Gold references: <strong>{eligibleGoldNotes.length}</strong>
                <br />
                New original source count: <strong>{options.baseSourceCount + eligibleNotes.length}</strong>
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

              {eligibleGoldNotes.length > 0 && (
                <div className='small mb-3'>
                  <strong>Frozen Gold references (benchmark-only):</strong>
                  <ul className='mb-0 mt-1'>
                    {eligibleGoldNotes.map((note) => (
                      <li key={note.alias}>{note.title || note.alias}</li>
                    ))}
                  </ul>
                </div>
              )}

              {eligibleNotes.length > 0 && (
                <div className='small mb-3'>
                  <strong>Will freeze as original sources:</strong>
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
              (eligibleNotes.length === 0 && eligibleGoldNotes.length === 0) ||
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
