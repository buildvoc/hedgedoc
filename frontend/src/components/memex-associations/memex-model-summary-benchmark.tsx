'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Badge, Button, Card, Form, Spinner, Table } from 'react-bootstrap'

type Attempt = {
  name: string
  status: string
  output?: string
  finish_reason?: string
  duration_seconds?: number
  error?: string
  score?: { coverage_proxy: number; coverage_total: number; missing_proxy: string[]; alerts: string[] }
}
type Report = {
  id?: string
  status?: string
  model?: string
  source_sha256?: string
  attempts?: Attempt[]
  error?: string
  state?: string
}
type ShortRun = { id: string; status: string; started_at?: string; model?: string; attempts: number }
const ENDPOINT = '/memex-association-benchmarks/summary'

export function MemexModelSummaryBenchmark() {
  const [runs, setRuns] = useState<ShortRun[]>([])
  const [selected, setSelected] = useState('')
  const [report, setReport] = useState<Report>()
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')

  const refreshList = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not list model benchmarks')
      setRuns(data.runs || [])
    } catch (e) { setError(String(e)) }
  }, [])

  const refreshRun = useCallback(async (id: string) => {
    try {
      const response = await fetch(`${ENDPOINT}?runId=${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not read model benchmark')
      setReport(data)
    } catch (e) { setError(String(e)) }
  }, [])

  useEffect(() => { void refreshList() }, [refreshList])
  useEffect(() => {
    if (!selected) return
    void refreshRun(selected)
    const interval = window.setInterval(() => { void refreshRun(selected) }, 6000)
    return () => window.clearInterval(interval)
  }, [selected, refreshRun])

  const start = async () => {
    setStarting(true)
    setError('')
    try {
      const response = await fetch(ENDPOINT, { method: 'POST' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Could not start model benchmark')
      setSelected(data.runId)
      setReport({ state: 'starting' })
      await refreshList()
    } catch (e) { setError(String(e)) }
    finally { setStarting(false) }
  }

  return <Card>
    <Card.Body>
      <h2 className='h4'>Direct model summary benchmark — separate from Wiki creation</h2>
      <p className='text-muted'>Uses the original one-page <strong>64_PAS_9980_FINAL</strong> source (PAS 9980:2026 p.48).
        Five direct llama.cpp completions: A baseline, B full requirements, C the B prompt repeated three times.
        No queue, wiki, trail, association, or citation writes.</p>
      <Alert variant='warning'>Stop Memex queue processing before starting. A/B/C scores are automated <strong>keyword coverage indicators only</strong>;
        verify factual correctness and the SHOULD/MUST distinction manually.</Alert>
      <div className='d-flex flex-wrap gap-3 align-items-end mb-3'>
        <Button onClick={() => void start()} disabled={starting}>{starting ? <><Spinner size='sm' animation='border' /> Starting</> : 'Run direct Gemma4 A/B/C benchmark'}</Button>
        <Form.Group style={{ minWidth: 300 }}>
          <Form.Label>Previous model runs</Form.Label>
          <Form.Select value={selected} onChange={(event) => { setSelected(event.target.value); setReport(undefined) }}>
            <option value=''>Select run</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.started_at?.slice(0,19) || r.id} — {r.status}</option>)}
          </Form.Select>
        </Form.Group>
        <Button variant='outline-secondary' onClick={() => void refreshList()}>Refresh</Button>
      </div>
      {error && <Alert variant='danger'>{error}</Alert>}
      {selected && <div className='mb-2'><strong>Run:</strong> <code>{selected}</code>{' '}
        <Badge bg={report?.status === 'completed' ? 'success' : 'secondary'}>{report?.status || report?.state || 'loading'}</Badge>
      </div>}
      {report?.model && <div className='small mb-2'>Model: <code>{report.model}</code></div>}
      {!!report?.attempts?.length && <Table size='sm' bordered responsive>
        <thead><tr><th>Test</th><th>Status</th><th>Keyword coverage proxy</th><th>Time</th><th>Finish</th></tr></thead>
        <tbody>{report.attempts.map((attempt) => <tr key={attempt.name}>
          <td>{attempt.name}</td><td>{attempt.status}</td>
          <td>{attempt.score ? `${attempt.score.coverage_proxy}/${attempt.score.coverage_total}` : '—'}</td>
          <td>{attempt.duration_seconds ?? '—'}s</td><td>{attempt.finish_reason ?? '—'}</td>
        </tr>)}</tbody>
      </Table>}
      {report?.attempts?.map((attempt) => <details key={attempt.name} className='mb-2'>
        <summary><strong>{attempt.name}</strong> — full model output and missing criteria</summary>
        {attempt.score && <div className='small'>Missing keyword checks: {attempt.score.missing_proxy.join(', ') || 'none'};
          Alerts: {attempt.score.alerts.join(', ') || 'none'}</div>}
        <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto' }}>{attempt.output || attempt.error || 'Running…'}</pre>
      </details>)}
      <p className='small text-muted mb-0'>Saved benchmark evidence: <code>memex/benchmarks/summary/results/&lt;run-id&gt;.json</code>
        {' '}and <code>&lt;run-id&gt;.md</code>. Independent human verification remains required.</p>
    </Card.Body>
  </Card>
}
