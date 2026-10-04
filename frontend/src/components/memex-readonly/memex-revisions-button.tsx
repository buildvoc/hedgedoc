'use client'

import { useDarkModeState } from '../../hooks/dark-mode/use-dark-mode-state'
import { AsyncLoadingBoundary } from '../common/async-loading-boundary/async-loading-boundary'
import { CommonModal } from '../common/modals/common-modal'
import { invertUnifiedPatch } from '../editor-page/sidebar/specific-sidebar-entries/revisions-sidebar-entry/revisions-modal/invert-unified-patch'
import { RevisionList } from '../editor-page/sidebar/specific-sidebar-entries/revisions-sidebar-entry/revisions-modal/revision-list'
import revisionStyles from '../editor-page/sidebar/specific-sidebar-entries/revisions-sidebar-entry/revisions-modal/revision-modal.module.scss'
import type { RevisionInterface, RevisionMetadataInterface } from '@hedgedoc/commons'
import { applyPatch, parsePatch } from 'diff'
import React, { Fragment, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Col, Form, Modal, Row } from 'react-bootstrap'
import {
  BarChartLine as IconBarChartLine,
  ClockHistory as IconClockHistory,
} from 'react-bootstrap-icons'
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer'
import { useAsync } from 'react-use'

interface MemexRevisionsButtonProps {
  noteAlias: string
  allowSnapshotQueue?: boolean
  allowSnapshotExtend?: boolean
  allowBenchmark?: boolean
}

interface SnapshotQueueSettings {
  defaultModel: string
  defaultNumCtx: number
  models: string[]
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

const getMemexRevisions = async (
  noteAlias: string,
): Promise<RevisionMetadataInterface[]> => {
  const response = await fetch(`/memex-revisions/${encodeURIComponent(noteAlias)}`, {
    cache: 'no-store',
  })

  if (!response.ok) {
    throw new Error(`Failed to load revisions (${response.status})`)
  }

  return (await response.json()) as RevisionMetadataInterface[]
}

const getMemexRevision = async (
  noteAlias: string,
  revisionId: string,
): Promise<RevisionInterface> => {
  const response = await fetch(
    `/memex-revisions/${encodeURIComponent(noteAlias)}/${encodeURIComponent(revisionId)}`,
    { cache: 'no-store' },
  )

  if (!response.ok) {
    throw new Error(`Failed to load revision (${response.status})`)
  }

  return (await response.json()) as RevisionInterface
}

const getSnapshotQueueSettings = async (): Promise<SnapshotQueueSettings> => {
  const response = await fetch('/memex-snapshot/queue', { cache: 'no-store' })

  if (!response.ok) {
    throw new Error(`Failed to load snapshot queue settings (${response.status})`)
  }

  return (await response.json()) as SnapshotQueueSettings
}

const getSnapshotExtendOptions = async (
  baseRevision: string,
): Promise<SnapshotExtendOptions> => {
  const response = await fetch(
    `/memex-snapshot?baseRevision=${encodeURIComponent(baseRevision)}`,
    { cache: 'no-store' },
  )

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(
      body.error || `Failed to load snapshot extension options (${response.status})`,
    )
  }

  return (await response.json()) as SnapshotExtendOptions
}

export const MemexRevisionsButton: React.FC<MemexRevisionsButtonProps> = ({
  noteAlias,
  allowSnapshotQueue = false,
  allowSnapshotExtend = false,
  allowBenchmark = false,
}) => {
  const [show, setShow] = useState(false)
  const [selectedRevisionId, setSelectedRevisionId] = useState<string>()
  const [queueModel, setQueueModel] = useState('')
  const [queueNumCtx, setQueueNumCtx] = useState(0)
  const [queueing, setQueueing] = useState(false)
  const [queueError, setQueueError] = useState('')
  const [queueSuccess, setQueueSuccess] = useState('')
  const [extendSourceAlias, setExtendSourceAlias] = useState('')
  const [extending, setExtending] = useState(false)
  const [extendError, setExtendError] = useState('')
  const darkModeEnabled = useDarkModeState()

  const {
    value: revisions,
    error: revisionsError,
    loading: revisionsLoading,
  } = useAsync(async () => {
    if (!show) {
      return []
    }
    return await getMemexRevisions(noteAlias)
  }, [noteAlias, show])

  const {
    value: revision,
    error: revisionError,
    loading: revisionLoading,
  } = useAsync(async () => {
    if (!show || selectedRevisionId === undefined) {
      return undefined
    }
    return await getMemexRevision(noteAlias, selectedRevisionId)
  }, [noteAlias, selectedRevisionId, show])

  const {
    value: snapshotQueueSettings,
    error: snapshotQueueSettingsError,
    loading: snapshotQueueSettingsLoading,
  } = useAsync(async () => {
    if (!show || !allowSnapshotQueue) {
      return undefined
    }
    return await getSnapshotQueueSettings()
  }, [allowSnapshotQueue, show])

  const {
    value: snapshotExtendOptions,
    error: snapshotExtendOptionsError,
    loading: snapshotExtendOptionsLoading,
  } = useAsync(async () => {
    if (!show || !allowSnapshotExtend || !selectedRevisionId) {
      return undefined
    }
    return await getSnapshotExtendOptions(selectedRevisionId)
  }, [allowSnapshotExtend, selectedRevisionId, show])

  useEffect(() => {
    if (!snapshotQueueSettings) {
      return
    }

    setQueueModel((current) => current || snapshotQueueSettings.defaultModel)
    setQueueNumCtx((current) => current || snapshotQueueSettings.defaultNumCtx)
  }, [snapshotQueueSettings])

  useEffect(() => {
    setExtendSourceAlias('')
    setExtendError('')
    setExtending(false)
  }, [selectedRevisionId])

  const previousRevisionContent = useMemo(() => {
    if (!revision) {
      return ''
    }

    const patches = parsePatch(revision.patch)
    if (patches.length === 0) {
      return ''
    }

    const inversePatch = invertUnifiedPatch(patches[0])
    return applyPatch(revision.content, inversePatch) || ''
  }, [revision])

  const queueSelectedSnapshot = async () => {
    if (!selectedRevisionId || !queueModel || !queueNumCtx) {
      return
    }

    setQueueing(true)
    setQueueError('')
    setQueueSuccess('')

    try {
      const response = await fetch('/memex-snapshot/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshotRevision: selectedRevisionId,
          llmModel: queueModel,
          numCtx: queueNumCtx,
        }),
      })
      const body = (await response.json().catch(() => ({}))) as {
        error?: string
        queuedCount?: number
        sourceCount?: number
      }

      if (!response.ok) {
        throw new Error(body.error || `Snapshot queue failed (${response.status})`)
      }

      const queuedCount = body.queuedCount ?? body.sourceCount
      setQueueSuccess(
        queuedCount !== undefined
          ? `Snapshot queued: ${queuedCount} frozen sources.`
          : 'Snapshot revision queued successfully.',
      )
    } catch (error) {
      setQueueError(
        error instanceof Error ? error.message : 'Unable to queue snapshot revision',
      )
    } finally {
      setQueueing(false)
    }
  }

  const extendSelectedSnapshot = async () => {
    if (!selectedRevisionId || !extendSourceAlias || !snapshotExtendOptions) {
      return
    }

    const selectedSource = snapshotExtendOptions.candidates.find(
      (source) => source.alias === extendSourceAlias,
    )
    if (!selectedSource) {
      return
    }

    const suggestedName = `${snapshotExtendOptions.baseName} + ${selectedSource.title}`.slice(
      0,
      120,
    )
    const requestedName = window.prompt('New snapshot name', suggestedName)
    if (requestedName === null) {
      return
    }

    const name = requestedName.trim()
    if (!name) {
      return
    }

    setExtending(true)
    setExtendError('')

    try {
      const response = await fetch('/memex-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          baseRevision: selectedRevisionId,
          sourceAlias: extendSourceAlias,
        }),
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

      window.alert(
        `Derived snapshot created with ${body.sourceCount ?? 0} sources.`,
      )
      window.location.reload()
    } catch (error) {
      setExtendError(
        error instanceof Error ? error.message : 'Unable to extend snapshot revision',
      )
      setExtending(false)
    }
  }

  const benchmarkSelectedSnapshot = () => {
    if (!selectedRevisionId) {
      return
    }

    window.location.assign(
      `/memex-association-benchmarks?snapshotRevision=${encodeURIComponent(selectedRevisionId)}`,
    )
  }

  const hide = () => {
    setShow(false)
    setSelectedRevisionId(undefined)
    setQueueError('')
    setQueueSuccess('')
    setExtendSourceAlias('')
    setExtendError('')
    setExtending(false)
  }

  return (
    <Fragment>
      <Button
        aria-label={`Show HedgeDoc revisions for ${noteAlias}`}
        onClick={() => setShow(true)}
        size='sm'
        variant='outline-secondary'
      >
        <IconClockHistory className='me-1' />
        Revisions
      </Button>

      <CommonModal
        show={show}
        onHide={hide}
        titleI18nKey='editor.modal.revision.title'
        titleIcon={IconClockHistory}
        showCloseButton={true}
        modalSize='xl'
        additionalClasses={revisionStyles['revision-modal']}
      >
        <Modal.Body>
          <Row>
            <Col lg={4} className={revisionStyles['scroll-col']}>
              {revisionsError ? (
                <Alert variant='warning'>
                  The server-side Memex revision proxy could not load HedgeDoc
                  revisions.
                </Alert>
              ) : (
                <RevisionList
                  loadingRevisions={revisionsLoading}
                  revisions={revisions}
                  onRevisionSelect={(revisionId) => {
                    setSelectedRevisionId(revisionId)
                    setQueueError('')
                    setQueueSuccess('')
                    setExtendSourceAlias('')
                    setExtendError('')
                  }}
                  selectedRevisionId={selectedRevisionId}
                />
              )}
            </Col>
            <Col lg={8} className={revisionStyles['scroll-col']}>
              {revisionError ? (
                <Alert variant='warning'>
                  This revision could not be loaded from HedgeDoc.
                </Alert>
              ) : (
                selectedRevisionId !== undefined && (
                  <AsyncLoadingBoundary
                    loading={revisionLoading || !revision}
                    componentName='MemexRevisionViewer'
                  >
                    <ReactDiffViewer
                      oldValue={previousRevisionContent}
                      newValue={revision?.content ?? ''}
                      splitView={false}
                      compareMethod={DiffMethod.WORDS}
                      useDarkTheme={darkModeEnabled}
                    />
                  </AsyncLoadingBoundary>
                )
              )}
            </Col>
          </Row>
          {allowSnapshotExtend && selectedRevisionId !== undefined && (
            <div className='mt-3 border-top pt-3'>
              <h5>Extend Snapshot</h5>
              <p className='text-muted mb-2'>
                Keep every frozen source revision from this snapshot and add one
                currently indexed HedgeDoc as a new frozen source revision.
              </p>
              {snapshotExtendOptionsError && (
                <Alert variant='warning'>
                  {snapshotExtendOptionsError.message}
                </Alert>
              )}
              {extendError && <Alert variant='danger'>{extendError}</Alert>}
              {!snapshotExtendOptionsError && (
                <Row className='g-2 align-items-end'>
                  <Col md={9}>
                    <Form.Label>HedgeDoc to add</Form.Label>
                    <Form.Select
                      value={extendSourceAlias}
                      disabled={snapshotExtendOptionsLoading || extending}
                      onChange={(event) => setExtendSourceAlias(event.target.value)}
                    >
                      <option value=''>Select a source…</option>
                      {(snapshotExtendOptions?.candidates ?? []).map((source) => (
                        <option key={source.alias} value={source.alias}>
                          {source.title} — {source.alias}
                        </option>
                      ))}
                    </Form.Select>
                    {snapshotExtendOptions && (
                      <Form.Text className='text-muted'>
                        Base snapshot: {snapshotExtendOptions.baseSourceCount} frozen
                        sources. The new snapshot will contain{' '}
                        {snapshotExtendOptions.baseSourceCount + 1}.
                      </Form.Text>
                    )}
                  </Col>
                  <Col md={3}>
                    <Button
                      className='w-100'
                      variant='success'
                      disabled={
                        snapshotExtendOptionsLoading ||
                        extending ||
                        !extendSourceAlias
                      }
                      onClick={() => void extendSelectedSnapshot()}
                    >
                      {extending ? 'Creating…' : 'Add + Snapshot'}
                    </Button>
                  </Col>
                </Row>
              )}
            </div>
          )}
          {allowSnapshotQueue && selectedRevisionId !== undefined && (
            <div className='mt-3 border-top pt-3'>
              <h5>Queue Snapshot</h5>
              <p className='text-muted mb-2'>
                Replay the exact frozen source revisions stored in this snapshot.
              </p>
              {snapshotQueueSettingsError && (
                <Alert variant='warning'>
                  Snapshot queue settings could not be loaded.
                </Alert>
              )}
              {queueError && <Alert variant='danger'>{queueError}</Alert>}
              {queueSuccess && <Alert variant='success'>{queueSuccess}</Alert>}
              {!snapshotQueueSettingsError && (
                <Row className='g-2 align-items-end'>
                  <Col md={7}>
                    <Form.Label>Ollama model</Form.Label>
                    <Form.Select
                      value={queueModel}
                      disabled={snapshotQueueSettingsLoading || queueing}
                      onChange={(event) => setQueueModel(event.target.value)}
                    >
                      {(snapshotQueueSettings?.models ?? []).map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </Form.Select>
                  </Col>
                  <Col md={3}>
                    <Form.Label>Context</Form.Label>
                    <Form.Control
                      type='number'
                      min={1024}
                      max={1048576}
                      step={1024}
                      value={queueNumCtx || ''}
                      disabled={snapshotQueueSettingsLoading || queueing}
                      onChange={(event) => setQueueNumCtx(Number(event.target.value))}
                    />
                  </Col>
                  <Col md={2}>
                    <Button
                      className='w-100'
                      variant='primary'
                      disabled={
                        snapshotQueueSettingsLoading ||
                        queueing ||
                        !queueModel ||
                        !queueNumCtx
                      }
                      onClick={() => void queueSelectedSnapshot()}
                    >
                      {queueing ? 'Queueing…' : 'Queue'}
                    </Button>
                  </Col>
                </Row>
              )}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          {allowBenchmark && selectedRevisionId !== undefined && (
            <Button variant='outline-primary' onClick={benchmarkSelectedSnapshot}>
              <IconBarChartLine className='me-1' />
              Benchmark
            </Button>
          )}
          <Button variant='secondary' onClick={hide}>
            Close
          </Button>
        </Modal.Footer>
      </CommonModal>
    </Fragment>
  )
}
