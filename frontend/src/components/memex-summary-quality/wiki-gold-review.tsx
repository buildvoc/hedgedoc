'use client'

import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { WikiAssociationResults } from './wiki-association-results'

type Source = { alias: string; title: string; revisionId: string }
type Reference = { alias: string; title: string; revisionId: string; sourceAlias: string; scope: string }
type Fact = { id: string; expectation: string }
type Approved = { facts: Fact[]; reviewer: string; reviewedAt: string }
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

  useEffect(() => {
    if (!snapshotRevision) return
    let current = true
    setBusy(true); setError(''); setResult(null)
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

  async function runBenchmark() {
    if (!approved || runBusy) return
    setRunBusy(true); setError('')
    try {
      const response = await fetch('/memex-wiki-summary-quality-benchmarks/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshotRevision }) })
      const data = await response.json() as { error?: string; runId?: string; summary?: string; model?: string }
      if (!response.ok || !data.runId || !data.summary || !data.model) throw new Error(data.error || `Run HTTP ${response.status}`)
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
      <p>One direct model call using shared Memex settings and the frozen ORIGINAL HedgeDoc only. Gold facts are never included in the model prompt.</p>
      <button type='button' disabled={!approved || runBusy} onClick={runBenchmark}>{runBusy ? 'Generating summary…' : 'Run benchmark → Recall / Precision / F1'}</button>
      {!approved && <p>Save the human-approved Gold Set first.</p>}
      {runResult && <><p>Run: {runResult.runId} · Model: {runResult.model} · scoring automatically</p><pre style={{whiteSpace:'pre-wrap',maxHeight:600,overflow:'auto'}}>{runResult.summary}</pre></>}
    </section>}
    {approved && <WikiAssociationResults snapshotRevision={snapshotRevision} latestRunId={runResult?.runId} />}
  </>
}
