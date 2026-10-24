'use client'

// Wiki results use the same card/ledger/table/chart/network presentation contract
// as memex-association-benchmarks, with Gold fact coverage as the measured subject.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Button, Card, Form, Spinner, Table } from 'react-bootstrap'

type Fact = { id: string; expectation: string }
type Judgement = {
  id: string
  prediction: 'supported' | 'partial' | 'missing' | 'incorrect'
  confidence: number
  outcome: string
  reason: string
  evidence: string
}
type Judged = {
  runId: string
  rows: Judgement[]
  status: string
  goldCoverage: { supported: number; partial: number; missing: number; incorrect: number; total: number; strictRecall: number }
}
type ClaimAudit = { runId: string; status: 'extract' | 'verify' | 'complete'; extractedChunks: number; totalChunks: number; verifiedClaims: number; totalClaims: number; precision: number | null; recall: number; f1: number | null; falsePositives: number | null; falseNegatives: number; auditedClaimCount: number | null; model: string; claims?: Array<{ claim: string; quote: string; supported: boolean; confidence: number; reason: string; sourceEvidence: string }> }
type Run = { runId: string; createdAt: string; model: string; judged: boolean; referenceAlias?: string; sourceAlias?: string }
type Details = { run: { runId: string; summary: string; model: string }; facts: Fact[]; result: Judged | null; error?: string }
const API = '/memex-wiki-summary-quality-benchmarks/judge'
const PRECISION_API = '/memex-wiki-summary-quality-benchmarks/precision'
const percent = (n: number | undefined) => Number.isFinite(n) ? `${(100 * (n ?? 0)).toFixed(1)}%` : '—'
const colors: Record<string, string> = { 'True positive': 'success', 'False negative': 'warning', 'Partial': 'info', 'Incorrect': 'danger' }

// Adapt the Association Benchmark's SVG quality chart. Only Gold recall is
// currently measurable: unsupported model claims were not audited for precision.
function QualityChart({ values }: { values: Array<{ id: string; recall: number }> }) {
  if (!values.length) return <Alert variant='secondary'>No LLM-evaluated Gold-fact runs yet.</Alert>
  const width = 920, height = 300, left = 58, right = 18, top = 20, bottom = 54
  const cw = width - left - right, ch = height - top - bottom
  const x = (i: number) => left + (values.length === 1 ? cw / 2 : i * cw / (values.length - 1))
  const y = (v: number) => top + (1 - Math.max(0, Math.min(1, v))) * ch
  return <div style={{ overflowX: 'auto' }}>
    <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: 760, width: '100%' }} role='img' aria-label='Wiki summary Gold-fact coverage trend'>
      {[0, 0.25, 0.5, 0.75, 1].map(t => <g key={t}>
        <line x1={left} x2={width - right} y1={y(t)} y2={y(t)} stroke='currentColor' opacity='0.12' />
        <text x={8} y={y(t) + 4} fill='currentColor' fontSize='12'>{(t * 100).toFixed(0)}%</text>
      </g>)}
      <polyline fill='none' stroke='currentColor' strokeDasharray='8 5' strokeWidth='2.5' points={values.map((v,i) => `${x(i)},${y(v.recall)}`).join(' ')} />
      {values.map((v,i) => <g key={v.id}>
        <circle cx={x(i)} cy={y(v.recall)} r='4' fill='currentColor' />
        <text fontSize='10' fill='currentColor' textAnchor='end' transform={`translate(${x(i)+3} ${height-12}) rotate(-35)`}>{v.id.slice(0, 10)}</text>
      </g>)}
    </svg>
    <div className='small text-muted'>Dashed: strict Gold-fact recall. Precision and F1 require a separate claim-level source audit.</div>
  </div>
}

// The same SVG radial-network presentation as the Association Benchmark,
// adapted to the one summary -> many Gold facts relationship. This is NOT a
// canonical Memex associated_with graph, and writes no graph associations.
function GoldFactNetwork({ rows }: { rows: Judgement[] }) {
  if (!rows.length) return <Alert variant='secondary'>Evaluate a saved run to display the Gold-fact network.</Alert>
  const width = 760, height = 520, cx = width / 2, cy = height / 2, radius = 195
  return <div style={{ overflowX: 'auto' }}>
    <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: 680, width: '100%' }} role='img' aria-label='Generated summary to Gold-fact coverage network'>
      {rows.map((r, i) => {
        const a = 2 * Math.PI * i / rows.length - Math.PI / 2
        const px = cx + radius * Math.cos(a), py = cy + radius * Math.sin(a)
        return <g key={r.id}>
          <line x1={cx} y1={cy} x2={px} y2={py} stroke='currentColor' strokeDasharray={r.prediction === 'missing' ? '7 5' : undefined} strokeWidth={r.prediction === 'incorrect' ? 4 : 2} opacity={r.prediction === 'supported' ? 0.65 : 0.95} />
          <circle cx={px} cy={py} r='18' fill='currentColor' opacity='0.14' />
          <circle cx={px} cy={py} r='5' fill='currentColor' />
          <text x={px} y={py + 32} textAnchor='middle' fontSize='12' fill='currentColor'>{r.id}</text>
        </g>
      })}
      <circle cx={cx} cy={cy} r='25' fill='currentColor' opacity='0.14' />
      <circle cx={cx} cy={cy} r='6' fill='currentColor' />
      <text x={cx} y={cy + 43} textAnchor='middle' fontSize='12' fill='currentColor'>Generated summary</text>
    </svg>
    <div className='small text-muted'>Solid = supported/partial; dashed = missing; heavy = incorrect. Edges depict evaluation coverage only, not Memex source associations.</div>
  </div>
}

export function WikiAssociationResults({ snapshotRevision, referenceAlias = '', latestRunId }: { snapshotRevision: string; referenceAlias?: string; latestRunId?: string }) {
  const [runs, setRuns] = useState<Run[]>([])
  const [selected, setSelected] = useState('')
  const [details, setDetails] = useState<Details | null>(null)
  const [trend, setTrend] = useState<Array<{ id: string; recall: number }>>([])
  const [modelFilter, setModelFilter] = useState('')
  const [outcomeFilter, setOutcomeFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [judging, setJudging] = useState(false)
  const [auditing, setAuditing] = useState(false)
  const [claimAudit, setClaimAudit] = useState<ClaimAudit | null>(null)
  const [auditsByRun, setAuditsByRun] = useState<Record<string, ClaimAudit>>({})
  const autoStarted = useRef(new Set<string>())
  const judgeStarted = useRef(new Set<string>())
  const [error, setError] = useState('')
  const loadDetails = useCallback(async (id: string) => {
    const r = await fetch(`${API}?snapshotRevision=${encodeURIComponent(snapshotRevision)}&runId=${encodeURIComponent(id)}`, { cache: 'no-store' })
    const data = await r.json() as Details
    if (!r.ok) throw new Error(data.error || `Results HTTP ${r.status}`)
    return data
  }, [snapshotRevision])
  const select = useCallback(async (id: string) => {
    setSelected(id); setDetails(null); setClaimAudit(null); setError('')
    if (!id) return
    setLoading(true)
    try {
      const [detail, precision] = await Promise.all([
        loadDetails(id),
        fetch(`${PRECISION_API}?runId=${encodeURIComponent(id)}`, { cache: 'no-store' })
          .then(async r => r.ok ? (await r.json() as { audit: ClaimAudit | null }).audit : null),
      ])
      setDetails(detail); setClaimAudit(precision); if (precision) setAuditsByRun(old => ({ ...old, [id]: precision }))
    } catch (e) { setError(String(e)) } finally { setLoading(false) }
  }, [loadDetails])
  const refresh = useCallback(async (preferred?: string) => {
    const r = await fetch(`${API}?snapshotRevision=${encodeURIComponent(snapshotRevision)}`, { cache: 'no-store' })
    const data = await r.json() as { runs?: Run[]; error?: string }
    if (!r.ok) throw new Error(data.error || `Run ledger HTTP ${r.status}`)
    const found = (data.runs || []).filter(run => !referenceAlias || run.referenceAlias === referenceAlias).slice().sort((a,b) => b.createdAt.localeCompare(a.createdAt))
    setRuns(found)
    // Cap background detailed requests; no model calls are made by this step.
    const evaluated = found.filter(v=>v.judged).slice(0, 25)
    const scores = await Promise.all(evaluated.map(async run => {
      try { const d = await loadDetails(run.runId); return d.result ? { id:run.runId, recall:d.result.goldCoverage.strictRecall } : null }
      catch { return null }
    }))
    setTrend(scores.filter((x): x is { id: string; recall: number } => x !== null).reverse())
    // Load already-saved scores for every ledger row, not only the selected run.
    const saved = await Promise.all(evaluated.map(async run => {
      try {
        const r = await fetch(`${PRECISION_API}?runId=${encodeURIComponent(run.runId)}`, { cache: 'no-store' })
        if (!r.ok) return null
        const { audit } = await r.json() as { audit: ClaimAudit | null }
        return audit ? [run.runId, audit] as const : null
      } catch { return null }
    }))
    setAuditsByRun(Object.fromEntries(saved.filter((a): a is readonly [string, ClaimAudit] => a !== null)))
    return preferred && found.some(x=>x.runId===preferred) ? preferred : found[0]?.runId || ''
  }, [loadDetails, snapshotRevision, referenceAlias])
  useEffect(() => {
    let active = true
    void refresh(latestRunId).then(id=> { if (active) void select(id) }).catch(e=> { if(active) setError(String(e)) })
    return () => { active = false }
  }, [refresh, select, latestRunId])
  const filteredRuns = useMemo(()=>runs.filter(r=>!modelFilter || r.model===modelFilter),[runs,modelFilter])
  const rows = useMemo(()=>(details?.result?.rows || []).filter(r=>!outcomeFilter || r.outcome===outcomeFilter),[details,outcomeFilter])
  const metrics = details?.result?.goldCoverage
  const factById = useMemo(()=>new Map((details?.facts || []).map(f=>[f.id,f.expectation])),[details])
  async function judge() {
    if (!selected || judging || details?.result) return
    setJudging(true); setError('')
    try {
      const r = await fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({runId:selected}) })
      const data = await r.json() as { result?: Judged; error?: string }
      if (!r.ok || !data.result) throw new Error(data.error || `Judge HTTP ${r.status}`)
      await refresh(selected)
      await select(selected)
    } catch(e) { setError(String(e)) } finally { setJudging(false) }
  }
  async function auditPrecision() {
    if (!selected || !details?.result || auditing || claimAudit?.status === 'complete') return
    setAuditing(true); setError('')
    try {
      // Each POST performs one checkpointed LLM request. Completed 161 Gold
      // assessments are reused, never repeated; refresh/resume is safe.
      for (let step = 0; step < 650; step++) {
        const response = await fetch(PRECISION_API, { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: selected }) })
        const payload = await response.json() as { audit?: ClaimAudit; error?: string }
        if (!response.ok || !payload.audit) throw new Error(payload.error || `Claim audit HTTP ${response.status}`)
        setClaimAudit(payload.audit)
        setAuditsByRun(old => ({ ...old, [selected]: payload.audit! }))
        if (payload.audit.status === 'complete') return
      }
      throw new Error('Claim audit step limit reached; refresh and resume')
    } catch (e) { setError(String(e)) } finally { setAuditing(false) }
  }
  // The user's Run Benchmark action creates a run, then selects it here.
  // Judge its Gold facts once, using the persisted judge result on refresh.
  useEffect(() => {
    if (!latestRunId || selected !== latestRunId || !details || loading || judging || details.result || judgeStarted.current.has(selected)) return
    judgeStarted.current.add(selected)
    void judge()
    // One attempt per generated run: explicit retry remains available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestRunId, selected, details, loading, judging])
  // A single Gold evaluation now automatically continues through claim checks
  // and F1 calculation. Existing judged runs start the audit on selection.
  // Mark each selected run once to avoid rerender-triggered duplicate model calls.
  useEffect(() => {
    if (!selected || !details?.result || loading || claimAudit?.status === 'complete' || autoStarted.current.has(selected)) return
    autoStarted.current.add(selected)
    void auditPrecision()
    // auditPrecision owns the in-flight request sequence; its changing identity
    // must not restart a checkpointed audit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, details, loading, claimAudit?.status])
  return <div className='d-flex flex-column gap-3 mt-4'>
    <Card><Card.Body>
      <div className='d-flex flex-wrap align-items-end gap-3 mb-3'>
        <Form.Group style={{ minWidth: 280 }}><Form.Label>Model filter</Form.Label><Form.Select value={modelFilter} onChange={e=>setModelFilter(e.target.value)}><option value=''>All models</option>{Array.from(new Set(runs.map(r=>r.model))).map(m=><option key={m} value={m}>{m}</option>)}</Form.Select></Form.Group>
        <div className='small text-muted'>{filteredRuns.length} run{filteredRuns.length===1?'':'s'} discovered from saved benchmark runs.</div>
      </div>
      <h2 className='h4'>Quality trend</h2>
      <QualityChart values={trend.filter(t=>filteredRuns.some(r=>r.runId===t.id))} />
    </Card.Body></Card>
    <Card><Card.Body>
      <h2 className='h4'>Run ledger</h2>
      <p className='small text-muted'>Model-assessed, unverified. Decision recall uses supported Gold facts; Decision precision independently checks generated summary claims against the frozen original. F1 is their harmonic mean. One Run Benchmark action evaluates Gold coverage, verifies generated claims against the frozen original, and saves Precision / Recall / F1. Incomplete results are never reported as final.</p>
      <div style={{ overflowX:'auto' }}><Table bordered hover responsive size='sm'><thead><tr><th>Run</th><th>Model</th><th>Scope</th><th>Decision Precision</th><th>Decision Recall</th><th>Decision F1</th><th>FP</th><th>FN</th><th>Pairs</th><th>Runtime</th></tr></thead><tbody>
        {filteredRuns.map(r=><tr key={r.runId} onClick={()=>void select(r.runId)} style={{cursor:'pointer'}}><td><code>{r.runId}</code></td><td><code>{r.model}</code></td><td>Gold facts</td><td>{auditsByRun[r.runId]?.status==='complete'?percent(auditsByRun[r.runId].precision ?? undefined):'—'}</td><td>{selected===r.runId && metrics?percent(metrics.strictRecall):'—'}</td><td>{auditsByRun[r.runId]?.status==='complete'?percent(auditsByRun[r.runId].f1 ?? undefined):'—'}</td><td>{auditsByRun[r.runId]?.status==='complete'?auditsByRun[r.runId].falsePositives:'—'}</td><td>{selected===r.runId && metrics ? metrics.total-metrics.supported:'—'}</td><td>{selected===r.runId && metrics?`${metrics.total}/${metrics.total}`:'—'}</td><td>—</td></tr>)}
      </tbody></Table></div>
    </Card.Body></Card>
    <Card><Card.Body>
      <div className='d-flex flex-wrap align-items-end gap-3 mb-3'>
        <Form.Group style={{minWidth:320}}><Form.Label>Detailed results run</Form.Label><Form.Select value={selected} onChange={e=>void select(e.target.value)}><option value=''>Select a run</option>{filteredRuns.map(r=><option key={r.runId} value={r.runId}>{r.runId}</option>)}</Form.Select></Form.Group>
        <Form.Group style={{minWidth:200}}><Form.Label>Outcome</Form.Label><Form.Select value={outcomeFilter} onChange={e=>setOutcomeFilter(e.target.value)}><option value=''>All outcomes</option>{['True positive','False negative','Partial','Incorrect'].map(o=><option key={o} value={o}>{o}</option>)}</Form.Select></Form.Group>
      </div>
      {error && <Alert variant='danger'>{error}</Alert>}
      {loading ? <div className='d-flex align-items-center gap-2'><Spinner animation='border' size='sm'/> Loading detailed results…</div> : <>
        {details && <div className='mb-3'><Badge bg={details.result?'info':'warning'}>{details.result?'Model assessed · unverified':'Pending LLM evaluation'}</Badge>{' '}<code>{details.run.model}</code>{' '}<Button variant='outline-secondary' size='sm' onClick={()=>void refresh(selected).then(id=>select(id)).catch(e=>setError(String(e)))}>Refresh runs</Button>
          <details className='mt-2'><summary>Frozen generated summary</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:340,overflow:'auto'}}>{details.run.summary}</pre></details>
          {!details.result && <div className='mt-2'><Button onClick={()=>void judge()} disabled={judging}>{judging ? 'Evaluating Gold facts…' : 'Retry Gold evaluation from saved run'}</Button></div>}
          {details.result && <div className='mt-2'>
            {auditing && <span className='small'><Spinner animation='border' size='sm' className='me-2' />Calculating Precision/F1 automatically…</span>}
            {!auditing && error && claimAudit?.status !== 'complete' &&
              <Button variant='outline-warning' size='sm' onClick={() => void auditPrecision()}>Retry scoring from checkpoint</Button>}
            {!auditing && !error && claimAudit?.status === 'complete' && <Badge bg='success'>Precision/F1 saved</Badge>}
            {claimAudit && <span className='ms-2 small'>
              {claimAudit.status === 'extract' ? `Extracted ${claimAudit.extractedChunks}/${claimAudit.totalChunks} summary chunks` :
                claimAudit.status === 'verify' ? `Verified ${claimAudit.verifiedClaims}/${claimAudit.totalClaims} summary claims` :
                `Claim precision ${percent(claimAudit.precision ?? undefined)} · Gold recall ${percent(claimAudit.recall)} · F1 ${percent(claimAudit.f1 ?? undefined)}`}
            </span>}
          </div>}
          {claimAudit?.status === 'complete' && <details className='mt-2'><summary>Audited generated claims ({claimAudit.auditedClaimCount})</summary>
            <div style={{maxHeight:320,overflowY:'auto'}}>{claimAudit.claims?.map((claim,i)=><p key={i} className='small mb-2'>
              <Badge bg={claim.supported?'success':'danger'}>{claim.supported?'Supported':'Unsupported'}</Badge>{' '}{claim.claim}<br/>{claim.reason}{claim.sourceEvidence && <><br/>Source: {claim.sourceEvidence}</>}
            </p>)}</div>
          </details>}
        </div>}
        <h2 className='h4'>Pair results</h2>
        <div style={{overflowX:'auto',maxHeight:520}}><Table bordered hover responsive size='sm'><thead><tr><th>Source A</th><th>Source B</th><th>Gold</th><th>Prediction</th><th>Confidence</th><th>Outcome</th><th>Reason</th></tr></thead><tbody>
          {rows.map(row=><tr key={row.id}><td>{details?.run.runId.slice(0,8)} · summary</td><td>{row.id}</td><td>{factById.get(row.id)||row.id}</td><td>{row.prediction}</td><td>{Number.isFinite(row.confidence)?`${row.confidence.toFixed(1)}%`:'—'}</td><td><Badge bg={colors[row.outcome]||'secondary'}>{row.outcome}</Badge></td><td style={{minWidth:320}}>{row.reason || '—'}{row.evidence && <details><summary>Evidence</summary><small>{row.evidence}</small></details>}</td></tr>)}
        </tbody></Table></div>
        <h2 className='h4 mt-4'>Association network</h2>
        <GoldFactNetwork rows={details?.result?.rows || []}/>
      </>}
    </Card.Body></Card>
  </div>
}
