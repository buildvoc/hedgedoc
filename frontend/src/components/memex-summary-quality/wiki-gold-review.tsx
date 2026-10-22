'use client'

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { WikiAssociationResults } from './wiki-association-results'

type Source = { alias: string; title: string; revisionId: string }
type Reference = { alias: string; title: string; revisionId: string; sourceAlias: string; scope: string }
type Fact = { id: string; expectation: string }
type Approved = { facts: Fact[]; reviewer: string; reviewedAt: string }
type SummaryNote = { alias: string; revisionId: string; title: string; generatorModel: string }
type GoldReply = { source: Source; reference: Reference; original: string; gold: string; approvedGoldSet: Approved | null; error?: string }
const API = '/memex-wiki-summary-quality-benchmarks/gold'

// Parse only the explicit Gold Facts section in the frozen HedgeDoc revision.
// Never infer facts from prose or update a saved, approved Gold Set.
function parseGoldFacts(markdown: string): Fact[] {
  const body = markdown.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
  const match = body.match(/^## Gold Facts\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)
  if (!match) return []
  const facts: Fact[] = []
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue
    const item = line.match(/^\s*-\s+\*\*([^*\r\n]+?):\*\*\s+(.+?)\s*$/)
    if (!item) throw new Error('Malformed Gold fact line: ' + line.slice(0, 120))
    facts.push({ id: item[1].trim(), expectation: item[2].trim() })
  }
  if (!facts.length || facts.some(f => !f.id || !f.expectation) ||
      new Set(facts.map(f => f.id)).size !== facts.length) {
    throw new Error('Gold Facts missing, empty or contains duplicate IDs')
  }
  return facts
}

// Human-reviewed facts are submitted to the installed, snapshot-scoped Gold API.
// This UI deliberately never infers factual claims or invokes a judge/model.
export function WikiGoldReview({ snapshotRevision }: { snapshotRevision: string }) {
  const [result, setResult] = useState<GoldReply | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [reviewer, setReviewer] = useState('human-ui')
  const [facts, setFacts] = useState<Fact[]>([{ id: '', expectation: '' }])
  const [position, setPosition] = useState(0)
  const [showSource, setShowSource] = useState(false)
  const [showReference, setShowReference] = useState(true)
  const [saved, setSaved] = useState(false)
  const [runBusy, setRunBusy] = useState(false)
  const [runResult, setRunResult] = useState<{ runId: string; summary: string; model: string } | null>(null)
  const [summaryMode, setSummaryMode] = useState<'generate' | 'existing'>('generate')
  const [summaryAlias, setSummaryAlias] = useState('')
  const [summaryPreview, setSummaryPreview] = useState<SummaryNote | null>(null)
  const [checkingSummary, setCheckingSummary] = useState(false)

  useEffect(() => {
    if (!snapshotRevision) return
    let current = true
    setBusy(true); setError(''); setResult(null); setRunResult(null); setSummaryPreview(null)
    fetch(`${API}?snapshotRevision=${encodeURIComponent(snapshotRevision)}`, { cache: 'no-store' })
      .then(async response => {
        const data = await response.json() as GoldReply
        if (!response.ok) throw new Error(data.error || `Gold API HTTP ${response.status}`)
        return data
      })
      .then(data => { if (current) {
        setResult(data)
        if (data.approvedGoldSet) {
          setFacts(data.approvedGoldSet.facts)
          setReviewer(data.approvedGoldSet.reviewer)
          setSaved(true)
        } else {
          const imported = parseGoldFacts(data.gold)
          if (imported.length) {
            setFacts(imported)
            setPosition(0)
            setSaved(false)
          } else {
            setFacts([{ id: '', expectation: '' }])
            setError('Frozen Gold Reference has no ## Gold Facts section. Update the Gold HedgeDoc and attach its new revision to a new snapshot before importing.')
          }
        }
      } })
      .catch(reason => { if (current) setError(String(reason)) })
      .finally(() => { if (current) setBusy(false) })
    return () => { current = false }
  }, [snapshotRevision])

  const valid = facts.length > 0 && facts.every(f => f.id.trim() && f.expectation.trim()) &&
    new Set(facts.map(f => f.id.trim())).size === facts.length
  const approved = Boolean(result?.approvedGoldSet || saved)
  const edit = (field: keyof Fact, value: string) => setFacts(old => old.map((fact, i) =>
    i === position ? { ...fact, [field]: value } : fact))
  const add = () => { setFacts(old => [...old, { id: '', expectation: '' }]); setPosition(facts.length) }
  const drop = () => { if (facts.length === 1) return; setFacts(old => old.filter((_,i) => i !== position)); setPosition(Math.max(0, position - 1)) }

  async function save() {
    if (!result || !valid || !reviewer.trim() || approved) return
    if (!window.confirm(`Approve ${facts.length} human-reviewed Gold facts for the frozen snapshot?`)) return
    setBusy(true); setError('')
    try {
      const response = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotRevision, reviewer: reviewer.trim(), facts: facts.map(f => ({ id: f.id.trim(), expectation: f.expectation.trim() })) }) })
      const data = await response.json() as { saved?: boolean; error?: string }
      if (!response.ok || !data.saved) throw new Error(data.error || `Save failed (${response.status})`)
      setSaved(true)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }

  async function checkSummary() {
    if (!result || !summaryAlias.trim()) return
    setCheckingSummary(true); setError(''); setSummaryPreview(null)
    try {
      const query = new URLSearchParams({ snapshotRevision, summaryAlias: summaryAlias.trim() })
      const response = await fetch(`/memex-wiki-summary-quality-benchmarks/run?${query}`, { cache: 'no-store' })
      const data = await response.json() as { sourceSummary?: SummaryNote; error?: string }
      if (!response.ok || !data.sourceSummary) throw new Error(data.error || 'Source-summary validation failed')
      setSummaryPreview(data.sourceSummary)
    } catch (reason) { setError(String(reason)) } finally { setCheckingSummary(false) }
  }

  async function runBenchmark() {
    if (!approved || runBusy || (summaryMode === 'existing' && !summaryAlias.trim())) return
    setRunBusy(true); setError('')
    try {
      const response = await fetch('/memex-wiki-summary-quality-benchmarks/run', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshotRevision, ...(summaryMode === 'existing' ? { summaryAlias: summaryAlias.trim() } : {}) }) })
      const data = await response.json() as { error?: string; runId?: string; summary?: string; model?: string }
      if (!response.ok || !data.runId || !data.summary || !data.model) throw new Error(data.error || `Run HTTP ${response.status}`)
      const judged = await fetch('/memex-wiki-summary-quality-benchmarks/judge', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({runId:data.runId}) })
      const scored = await judged.json() as { error?: string; result?: { decisionMetrics?: { precision:number; recall:number; f1:number } } }
      if (!judged.ok || !scored.result?.decisionMetrics) {
        setRunResult({ runId: data.runId, summary: data.summary, model: data.model })
        throw new Error(scored.error || 'Model decision scoring incomplete; retry from Run Ledger')
      }
      // Refresh the ledger only AFTER scoring; never race a second judge request.
      setRunResult({ runId: data.runId, summary: data.summary, model: data.model })
    } catch (reason) { setError(String(reason)) } finally { setRunBusy(false) }
  }

  const card: CSSProperties = { border: '1px solid #8b929a', borderRadius: 8, padding: 18, marginBottom: 20 }
  const field: CSSProperties = { width: '100%', padding: 8, marginTop: 5, marginBottom: 12 }
  return <>
    <section style={card}>
      <h2>Gold review</h2>
      {!snapshotRevision && <p>Select a snapshot revision from <a href='/memex-snapshots'>Memex Snapshots</a> → Wiki Summary Quality.</p>}
      {busy && <p>Loading or saving…</p>}
      {error && <p role='alert' style={{ color: '#dc3545' }}>{error}</p>}
      {result && <>
        <p><strong>Snapshot:</strong> {snapshotRevision}</p>
        <p><strong>Original:</strong> {result.source.title} ({result.source.alias})</p>
        <p><strong>Gold Reference:</strong> {result.reference.title} ({result.reference.alias})</p>
        <p><strong>Scope:</strong> {result.reference.scope}</p>
        <p><strong>Status:</strong> {approved ? 'Gold Set saved (frozen)' : `${facts.filter(f => f.id.trim() && f.expectation.trim()).length}/${facts.length} facts complete`}</p>
        <button type='button' onClick={() => setShowSource(!showSource)}>{showSource ? 'Hide' : 'Show'} frozen original</button>{' '}
        <button type='button' onClick={() => setShowReference(!showReference)}>{showReference ? 'Hide' : 'Show'} frozen Gold Reference</button>
        {showSource && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', marginTop: 12 }}>{result.original}</pre>}
        {showReference && <pre style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', marginTop: 12 }}>{result.gold}</pre>}
      </>}
    </section>
    {result && <section style={card}>
      <h2>Gold fact wizard</h2>
      <p>Review each important fact against the original. Facts import automatically from the frozen Gold Reference; verify each against the original before saving.</p>
      <p><strong>Fact {position + 1} of {facts.length}</strong></p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <button type='button' disabled={position === 0} onClick={() => setPosition(i => i - 1)}>Previous</button>
        <button type='button' disabled={position >= facts.length - 1} onClick={() => setPosition(i => i + 1)}>Next</button>
        <button type='button' disabled={approved} onClick={add}>Add expected fact</button>
        <button type='button' disabled={approved || facts.length < 2} onClick={drop}>Remove fact</button>
      </div>
      <label>Fact ID<input style={field} disabled={approved} value={facts[position].id} maxLength={120} onChange={e => edit('id', e.target.value)} placeholder='14-1' /></label>
      <label>Expected source fact<textarea style={field} disabled={approved} value={facts[position].expectation} rows={3} maxLength={2000} onChange={e => edit('expectation', e.target.value)} /></label>
      <label>Reviewer<input style={field} disabled={approved} value={reviewer} onChange={e => setReviewer(e.target.value)} maxLength={120} /></label>
      <button type='button' onClick={save} disabled={busy || approved || !valid || !reviewer.trim()}>{approved ? 'Gold Set saved' : `Save Gold Set (${facts.length} facts)`}</button>
      {!valid && !approved && <p>Enter an ID and an expected fact for every row; IDs must be unique.</p>}
      {approved && <p>The Gold Set is frozen for this snapshot. Association Benchmarks remain unchanged.</p>}
    </section>}
    {result && <section style={card}>
      <h2>Run Benchmark</h2>
      <p>Generate a new summary from the frozen original, or evaluate an existing source-summary HedgeDoc. Gold facts never enter summary generation.</p>
      <div style={{ display: 'flex', gap: 18, marginBottom: 12 }}>
        <label><input type='radio' checked={summaryMode === 'generate'} onChange={() => { setSummaryMode('generate'); setSummaryPreview(null) }} /> Generate new summary</label>
        <label><input type='radio' checked={summaryMode === 'existing'} onChange={() => setSummaryMode('existing')} /> Existing source-summary</label>
      </div>
      {summaryMode === 'existing' && <div style={{ marginBottom: 12 }}>
        <label htmlFor='benchmark-summary-alias'>Source-summary HedgeDoc alias or /n/ URL</label>
        <input id='benchmark-summary-alias' style={field} value={summaryAlias} onChange={e => { setSummaryAlias(e.target.value); setSummaryPreview(null) }} placeholder='Paste existing HedgeDoc note alias or URL' />
        <button type='button' disabled={checkingSummary || !approved || !summaryAlias.trim() || runBusy} onClick={() => void checkSummary()}>{checkingSummary ? 'Checking…' : 'Validate source-summary (read-only)'}</button>
        {summaryPreview && <p>Validated: {summaryPreview.title} · {summaryPreview.alias} · revision {summaryPreview.revisionId} · model {summaryPreview.generatorModel}. The current revision will be frozen when Run is clicked.</p>}
      </div>}
      <button type='button' disabled={!approved || runBusy || (summaryMode === 'existing' && !summaryAlias.trim())} onClick={runBenchmark}>{runBusy ? 'Running benchmark and scoring…' : 'Run Benchmark — Precision / Recall / F1'}</button>
      {!approved && <p>Save the human-approved Gold Set first.</p>}
      {runResult && <><p>Run: {runResult.runId} · Summary model: {runResult.model} · see Run Ledger for saved scores or retry</p><pre style={{whiteSpace:'pre-wrap',maxHeight:600,overflow:'auto'}}>{runResult.summary}</pre></>}
    </section>}
    {approved && <WikiAssociationResults snapshotRevision={snapshotRevision} latestRunId={runResult?.runId} />}
  </>
}
