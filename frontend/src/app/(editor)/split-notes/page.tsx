'use client'

import React, { useEffect, useState } from 'react'
import type { DoclingDocument } from '../../../components/editor-page/renderer-pane/docling-document'
import { DoclingRendererPane } from '../../../components/editor-page/renderer-pane/docling-renderer-pane'
import {
  Alert,
  Badge,
  Button,
  Card,
  Container,
  Form,
  Spinner
} from 'react-bootstrap'

interface Section {
  id: number
  title: string
  anchor: string
  ref?: string
  label?: string
}

interface Proposal {
  title: string
  reason: string
  sectionIds: number[]
  status: string
  selected: boolean
}

interface Analysis {
  alias: string
  sourceTitle: string
  sourceKind: 'markdown' | 'docling'
  canCreate: boolean
  sectionCount: number
  sections: Section[]
  summary: string
  proposals: Omit<Proposal, 'selected'>[]
}

interface CreatedNote {
  title: string
  status: string
  alias: string
  url: string
}

interface PreviewPayload {
  sourceKind: 'markdown' | 'docling'
  title: string
  status: string
  markdown?: string
  document?: DoclingDocument
}

interface ModelServiceStatus {
  key: 'ollama' | 'llamacpp'
  label: string
  unit: string
  status: string
  active: boolean
}

type ProposalPreview =
  | { status: 'loading' }
  | { status: 'ready'; payload: PreviewPayload }
  | { status: 'error'; message: string }

export default function SplitNotesPage() {
  const [source, setSource] = useState('')
  const [analysis, setAnalysis] =
    useState<Analysis | null>(null)
  const [proposals, setProposals] =
    useState<Proposal[]>([])
  const [created, setCreated] =
    useState<CreatedNote[]>([])
  const [previews, setPreviews] =
    useState<Record<number, ProposalPreview>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [modelServices, setModelServices] =
    useState<ModelServiceStatus[]>([])
  const [serviceRefreshing, setServiceRefreshing] =
    useState(false)
  const [serviceBusy, setServiceBusy] =
    useState<string | null>(null)
  const [serviceError, setServiceError] = useState('')

  async function refreshModelServices() {
    setServiceRefreshing(true)
    setServiceError('')

    try {
      const response = await fetch(
        '/memex-model-services',
        { cache: 'no-store' }
      )
      const body = await response.json()

      if (!response.ok) {
        throw new Error(
          body.error ?? `HTTP ${response.status}`
        )
      }

      setModelServices(body.services ?? [])
    } catch (err) {
      setServiceError(
        err instanceof Error
          ? err.message
          : 'Could not read model service status'
      )
    } finally {
      setServiceRefreshing(false)
    }
  }

  async function controlModelService(
    service: 'ollama' | 'llamacpp',
    action: 'start' | 'stop'
  ) {
    setServiceBusy(`${service}:${action}`)
    setServiceError('')

    try {
      const response = await fetch(
        '/memex-model-services',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            service,
            action
          })
        }
      )
      const body = await response.json()

      if (!response.ok) {
        throw new Error(
          body.error ?? `HTTP ${response.status}`
        )
      }

      setModelServices(body.services ?? [])
    } catch (err) {
      setServiceError(
        err instanceof Error
          ? err.message
          : 'Model service action failed'
      )
    } finally {
      setServiceBusy(null)
    }
  }

  useEffect(() => {
    void refreshModelServices()
  }, [])

  async function analyze() {
    setBusy(true)
    setError('')
    setMessage('')
    setCreated([])
    setPreviews({})

    try {
      const response = await fetch(
        '/memex-split-notes',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'analyze',
            source
          })
        }
      )

      const body = await response.json()

      if (!response.ok) {
        throw new Error(
          body.error ?? `HTTP ${response.status}`
        )
      }

      const result = body as Analysis

      setAnalysis(result)

      setProposals(
        result.proposals.map((proposal) => ({
          ...proposal,
          status: proposal.status ?? 'draft',
          selected: true
        }))
      )
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Analysis failed'
      )
    } finally {
      setBusy(false)
    }
  }

  function patchProposal(
    index: number,
    patch: Partial<Proposal>
  ) {
    setProposals((current) =>
      current.map((proposal, i) =>
        i === index
          ? { ...proposal, ...patch }
          : proposal
      )
    )

    if (
      patch.title !== undefined ||
      patch.status !== undefined ||
      patch.sectionIds !== undefined
    ) {
      setPreviews((current) => {
        const next = { ...current }
        delete next[index]
        return next
      })
    }
  }

  async function previewProposal(index: number) {
    const proposal = proposals[index]
    if (!proposal) return

    setPreviews((current) => ({
      ...current,
      [index]: { status: 'loading' }
    }))

    try {
      const response = await fetch(
        '/memex-split-notes',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'preview',
            source,
            proposal: {
              title: proposal.title,
              reason: proposal.reason,
              sectionIds: proposal.sectionIds,
              status: proposal.status
            }
          })
        }
      )

      const body = await response.json()

      if (!response.ok) {
        throw new Error(
          body.error ?? `HTTP ${response.status}`
        )
      }

      const payload = body as PreviewPayload

      if (
        payload.sourceKind === 'docling' &&
        !payload.document
      ) {
        throw new Error(
          'Preview returned no DoclingDocument'
        )
      }

      if (
        payload.sourceKind === 'markdown' &&
        typeof payload.markdown !== 'string'
      ) {
        throw new Error(
          'Preview returned no Markdown content'
        )
      }

      setPreviews((current) => ({
        ...current,
        [index]: {
          status: 'ready',
          payload
        }
      }))
    } catch (err) {
      setPreviews((current) => ({
        ...current,
        [index]: {
          status: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Preview failed'
        }
      }))
    }
  }

  async function createSelected() {
    const selected = proposals.filter(
      (proposal) => proposal.selected
    )

    if (selected.length === 0) return

    setBusy(true)
    setError('')
    setMessage('')
    setCreated([])

    try {
      const response = await fetch(
        '/memex-split-notes',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action: 'create',
            source,
            proposals: selected.map(
              ({
                title,
                reason,
                sectionIds,
                status
              }) => ({
                title,
                reason,
                sectionIds,
                status
              })
            )
          })
        }
      )

      const body = await response.json()

      if (!response.ok) {
        throw new Error(
          body.error ?? `HTTP ${response.status}`
        )
      }

      setCreated(body.created ?? [])

      const failed = body.failures?.length ?? 0

      setMessage(
        `${body.created?.length ?? 0} HedgeDoc(s) created` +
          (failed
            ? `; ${failed} failed.`
            : '.')
      )

      if (failed) {
        setError(
          body.failures
            .map(
              (failure: {
                title: string
                error: string
              }) =>
                `${failure.title}: ${failure.error}`
            )
            .join('\n')
        )
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Create failed'
      )
    } finally {
      setBusy(false)
    }
  }

  const sectionMap = new Map<number, Section>(
    analysis?.sections.map((section) => [
      section.id,
      section
    ] as [number, Section]) ?? []
  )

  const selectedCount = proposals.filter(
    (proposal) => proposal.selected
  ).length

  return (
    <Container className='py-4'>
      <div className='mb-4'>
        <h1>LLM Split HedgeDoc</h1>

        <p className='text-muted'>
          One existing HedgeDoc → LLM decides how many
          useful standalone HedgeDocs should be created.
          You review the plan and choose the status of
          each new note before creation.
        </p>
      </div>

      <Card className='mb-4'>
        <Card.Header className='d-flex align-items-center justify-content-between'>
          <strong>Model services (.99)</strong>
          <Button
            size='sm'
            variant='outline-secondary'
            disabled={serviceRefreshing || serviceBusy !== null}
            onClick={() => void refreshModelServices()}>
            {serviceRefreshing && (
              <Spinner size='sm' className='me-2' />
            )}
            Refresh
          </Button>
        </Card.Header>
        <Card.Body>
          {serviceError && (
            <Alert variant='danger' className='py-2'>
              {serviceError}
            </Alert>
          )}

          <div className='small text-muted mb-3'>
            Remote control from .142 → 192.168.1.99.
            Stop one model service before starting the other
            when they share GPU memory.
          </div>

          {modelServices.map((service) => (
            <div
              key={service.key}
              className='d-flex flex-wrap align-items-center gap-2 mb-2'>
              <strong style={{ minWidth: '110px' }}>
                {service.label}
              </strong>

              <Badge
                bg={service.active ? 'success' : 'secondary'}>
                {service.status}
              </Badge>

              <Button
                size='sm'
                variant='outline-success'
                disabled={
                  service.active ||
                  serviceBusy !== null ||
                  serviceRefreshing
                }
                onClick={() =>
                  void controlModelService(
                    service.key,
                    'start'
                  )
                }>
                {serviceBusy === `${service.key}:start` && (
                  <Spinner size='sm' className='me-2' />
                )}
                Start
              </Button>

              <Button
                size='sm'
                variant='outline-danger'
                disabled={
                  !service.active ||
                  serviceBusy !== null ||
                  serviceRefreshing
                }
                onClick={() =>
                  void controlModelService(
                    service.key,
                    'stop'
                  )
                }>
                {serviceBusy === `${service.key}:stop` && (
                  <Spinner size='sm' className='me-2' />
                )}
                Stop
              </Button>

              <span className='small text-muted'>
                {service.unit}
              </span>
            </div>
          ))}
        </Card.Body>
      </Card>

      <Card className='mb-4'>
        <Card.Body>
          <Form.Label>
            Existing HedgeDoc URL or alias
          </Form.Label>

          <div className='d-flex gap-2'>
            <Form.Control
              value={source}
              disabled={busy}
              placeholder='http://192.168.1.142:8180/n/...'
              onChange={(event) =>
                setSource(event.target.value)
              }
            />

            <Button
              onClick={analyze}
              disabled={busy || !source.trim()}>
              {busy && (
                <Spinner
                  size='sm'
                  className='me-2'
                />
              )}
              Analyze with LLM
            </Button>
          </div>
        </Card.Body>
      </Card>

      {error && (
        <Alert
          variant='danger'
          style={{ whiteSpace: 'pre-wrap' }}>
          {error}
        </Alert>
      )}

      {message && (
        <Alert variant='success'>
          {message}
        </Alert>
      )}

      {analysis && (
        <>
          <div className='d-flex flex-wrap align-items-center gap-2 mb-3'>
            <h2 className='mb-0'>
              {analysis.sourceTitle}
            </h2>

            <Badge bg='secondary'>
              {analysis.sectionCount}{' '}
              {analysis.sourceKind === 'docling'
                ? 'Docling body units'
                : 'source sections'}
            </Badge>

            {analysis.sourceKind === 'docling' && (
              <Badge bg='info'>
                native Docling segmentation
              </Badge>
            )}

            <Badge bg='primary'>
              LLM recommends {proposals.length}{' '}
              HedgeDoc{proposals.length === 1 ? '' : 's'}
            </Badge>
          </div>

          {analysis.summary && (
            <Alert variant='info'>
              {analysis.summary}
            </Alert>
          )}

          {analysis.sourceKind === 'docling' && (
            <Alert variant='success'>
              Docling creation enabled: the reviewed structural
              segmentation is materialized deterministically into
              standalone DoclingDocuments. Creation makes no second
              LLM call.
            </Alert>
          )}

          {proposals.map((proposal, index) => (
            <Card
              key={index}
              className='mb-3'>
              <Card.Body>
                <div className='d-flex gap-3'>
                  <Form.Check
                    type='checkbox'
                    checked={proposal.selected}
                    disabled={busy}
                    onChange={(event) =>
                      patchProposal(index, {
                        selected:
                          event.target.checked
                      })
                    }
                  />

                  <div className='flex-grow-1'>
                    <div className='row g-3'>
                      <div className='col-md-8'>
                        <Form.Label>
                          New HedgeDoc title
                        </Form.Label>

                        <Form.Control
                          value={proposal.title}
                          disabled={busy}
                          onChange={(event) =>
                            patchProposal(index, {
                              title:
                                event.target.value
                            })
                          }
                        />
                      </div>

                      <div className='col-md-4'>
                        <Form.Label>
                          Status
                        </Form.Label>

                        <Form.Select
                          value={proposal.status}
                          disabled={busy}
                          onChange={(event) =>
                            patchProposal(index, {
                              status:
                                event.target.value
                            })
                          }>
                          <option value='draft'>
                            draft
                          </option>
                          <option value='stable'>
                            stable
                          </option>
                          <option value='experimental'>
                            experimental
                          </option>
                        </Form.Select>

                        <div className='d-grid mt-2'>
                          <Button
                            variant='outline-primary'
                            size='sm'
                            disabled={
                              busy ||
                              previews[index]?.status ===
                                'loading'
                            }
                            onClick={() =>
                              previewProposal(index)
                            }>
                            {previews[index]?.status ===
                              'loading' && (
                              <Spinner
                                size='sm'
                                className='me-2'
                              />
                            )}
                            {previews[index]?.status ===
                            'ready'
                              ? 'Refresh preview'
                              : 'Preview created note'}
                          </Button>
                        </div>

                        <div
                          className='border rounded mt-2 bg-body'
                          style={{
                            height: '420px',
                            overflow: 'auto'
                          }}>
                          {!previews[index] && (
                            <div className='p-3 text-muted'>
                              Preview not loaded. Use the
                              button above to render the exact
                              content that Create Selected will
                              materialize.
                            </div>
                          )}

                          {previews[index]?.status ===
                            'loading' && (
                            <div className='p-3 text-muted'>
                              Building exact pre-create
                              preview…
                            </div>
                          )}

                          {previews[index]?.status ===
                            'error' && (
                            <Alert
                              variant='danger'
                              className='m-2'>
                              {previews[index].message}
                            </Alert>
                          )}

                          {previews[index]?.status ===
                            'ready' &&
                            previews[index].payload
                              .sourceKind ===
                              'docling' && (
                              <DoclingRendererPane
                                document={
                                  previews[index].payload
                                    .document ?? null
                                }
                              />
                            )}

                          {previews[index]?.status ===
                            'ready' &&
                            previews[index].payload
                              .sourceKind ===
                              'markdown' && (
                              <pre
                                className='small p-2 mb-0'
                                style={{
                                  minHeight: '100%',
                                  whiteSpace: 'pre-wrap'
                                }}>
                                {previews[index].payload
                                  .markdown}
                              </pre>
                            )}
                        </div>
                      </div>
                    </div>

                    <p className='mt-3 mb-2'>
                      {proposal.reason}
                    </p>

                    <div className='small text-muted'>
                      {analysis.sourceKind === 'docling'
                        ? 'Docling structural units:'
                        : 'Source sections:'}
                    </div>

                    <div className='d-flex flex-wrap gap-2 mt-1'>
                      {proposal.sectionIds.map(
                        (sectionId) => {
                          const section =
                            sectionMap.get(sectionId)

                          return (
                            <Badge
                              bg='secondary'
                              key={sectionId}>
                              {section
                                ? `${sectionId}. ${section.label ? `${section.label} ` : ''}${section.title}${section.ref ? ` [${section.ref}]` : ''}`
                                : `Section ${sectionId}`}
                            </Badge>
                          )
                        }
                      )}
                    </div>
                  </div>
                </div>
              </Card.Body>
            </Card>
          ))}

          <div className='d-flex justify-content-end mb-4'>
            <Button
              variant='success'
              size='lg'
              disabled={
                busy ||
                selectedCount === 0 ||
                !analysis.canCreate
              }
              onClick={createSelected}>
              {busy && (
                <Spinner
                  size='sm'
                  className='me-2'
                />
              )}
              Create Selected ({selectedCount})
            </Button>
          </div>
        </>
      )}

      {created.length > 0 && (
        <Card>
          <Card.Header>
            Created HedgeDocs
          </Card.Header>

          <Card.Body>
            {created.map((note) => (
              <div
                key={note.alias}
                className='mb-2'>
                <a
                  href={note.url}
                  target='_blank'
                  rel='noreferrer'>
                  {note.title}
                </a>{' '}
                <Badge
                  bg={
                    note.status === 'stable'
                      ? 'success'
                      : note.status ===
                          'experimental'
                        ? 'warning'
                        : 'secondary'
                  }>
                  {note.status}
                </Badge>
              </div>
            ))}
          </Card.Body>
        </Card>
      )}
    </Container>
  )
}
