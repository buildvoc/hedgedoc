'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type Page = { alias: string; title: string; pageType: string }
type Relation = { topicAlias: string; entityAlias: string; rationale: string; approvedAt: string }
type Catalogue = {
  topics: Page[]
  entities: Page[]
  relations: Relation[]
  writeEnabled: boolean
  counts?: {
    sourceSummary: number
    entity: number
    topic: number
    comparison: number
    synthesis: number
    total: number
  }
  error?: string
}
type Group = { name: string; count: number; summaries: string[]; rawSources: string[] }
type Pair = { topic: string; entity: string; count: number; summaries: string[] }
type Job = {
  available: boolean
  id?: string
  state?: 'running' | 'paused' | 'verifying' | 'ready' | 'applied'
  step?: number
  totalSteps?: number
  verified?: number
  reviews?: number
  rejectedCandidates?: number
  flaggedSummaries?: string[]
  sourceSummaries?: number
  wikiTopics?: number
  wikiEntities?: number
  model?: string
  generatedTopics?: Group[]
  generatedEntities?: Group[]
  navigationCandidates?: Pair[]
  ready?: boolean
  committed?: boolean
  sourceSummariesApplied?: number
  approved?: { summaries: number; topics: number; entities: number; cooccurrences: number; updatedAt: string | null }
}

type WikiPublish = {
  available: boolean
  id?: string
  state?: 'running' | 'paused' | 'completed'
  total?: number
  processed?: number
  created?: number
  skippedExisting?: number
  rejectedCount?: number
  rejected?: string[]
  indexSourceCount?: number
  minimumWaitSeconds?: number
  graphState?: 'pending' | 'created' | 'preserved'
  graphAlias?: string | null
}

export function MemexOkfTopicEntitySection() {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [filter, setFilter] = useState('')
  const stopRequested = useRef(false)
  const publishStop = useRef(false)
  const [wikiJob, setWikiJob] = useState<WikiPublish | null>(null)
  const [wikiConfirmation, setWikiConfirmation] = useState('')

  const refreshCatalogue = useCallback(async () => {
    const response = await fetch('/memex-okf-topic-entity', { cache: 'no-store' })
    const body = (await response.json()) as Catalogue
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
    setCatalogue(body)
  }, [])

  useEffect(() => { void refreshCatalogue().catch((e: unknown) => setError(String(e))) }, [refreshCatalogue])

  const call = useCallback(async (method: 'GET' | 'POST', payload?: Record<string, unknown>): Promise<Job> => {
    const response = await fetch('/memex-okf-topic-entity/refresh', {
      method, cache: 'no-store',
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    const value = (await response.json()) as Job & { error?: string }
    if (!response.ok) {
      if (response.status === 429) {
        const wait = Math.max(5, Math.min(600, Number(response.headers.get('retry-after') ?? 300) || 300))
        const error = new Error(`HedgeDoc API rate-limited. Resume in ${wait}s; progress checkpointed.`) as Error & { retrySeconds?: number }
        error.retrySeconds = wait
        throw error
      }
      throw new Error(value.error ?? `HTTP ${response.status}`)
    }
    return value
  }, [])

  // Publishing is a separate, resumable, human-authorized phase. Unlike the
  // read-only LLM preview it creates only NEW derived Wiki Topic/Entity pages.
  const wikiCall = useCallback(async (method: 'GET' | 'POST', payload?: Record<string, unknown>): Promise<WikiPublish> => {
    const response = await fetch('/memex-okf-topic-entity/wiki-publish', {
      method, cache: 'no-store',
      headers: { ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    const value = (await response.json()) as WikiPublish & { error?: string; retrySeconds?: number }
    if (!response.ok) {
      const error = new Error(value.error ?? `Wiki publication HTTP ${response.status}`) as Error & { retrySeconds?: number }
      if (response.status === 429) error.retrySeconds = Math.max(5,
        Math.min(600, value.retrySeconds ?? (Number(response.headers.get('retry-after') ?? 300) || 300)))
      throw error
    }
    return value
  }, [])

  const publishIterate = async (initial: WikiPublish) => {
    let current = initial
    while (current.state === 'running' || current.state === 'paused') {
      if (publishStop.current) {
        current = await wikiCall('POST', { action: 'pause', id: current.id })
        setWikiJob(current)
        setMessage('Wiki publication paused; completed pages and progress are saved.')
        return
      }
      const delay = current.minimumWaitSeconds ?? 0
      if (delay > 0) {
        setMessage(`Publishing derived Wiki pages: ${current.processed ?? 0}/${current.total ?? 0}. Next safe API batch in ${delay}s.`)
        for (let remaining = delay; remaining > 0 && !publishStop.current; remaining -= 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2, remaining) * 1000))
        }
        if (publishStop.current) continue
      }
      try {
        current = await wikiCall('POST', { action: 'step', id: current.id })
        setWikiJob(current)
      } catch (e) {
        const seconds = (e as { retrySeconds?: number }).retrySeconds
        if (!seconds) throw e
        setMessage(`HedgeDoc API 429: Wiki progress saved. Retrying in ${seconds}s.`)
        for (let remaining = seconds; remaining > 0 && !publishStop.current; remaining -= 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2, remaining) * 1000))
        }
      }
    }
    if (current.state === 'completed') {
      setMessage(`Wiki publication complete: ${current.created ?? 0} new Topic/Entity pages created; nodeBook graph: ${current.graphState ?? 'unknown'}; ${current.skippedExisting ?? 0} existing pages preserved. Check /memex-wiki.`)
      await refreshCatalogue()
    }
  }

  const publish = async (resume: boolean) => {
    setBusy(true); setError(''); setMessage(''); publishStop.current = false
    try {
      const initial = resume && wikiJob?.id
        ? wikiJob
        : await wikiCall('POST', { action: 'prepare', confirmation: 'APPLY' })
      setWikiJob(initial)
      setWikiConfirmation('')
      await publishIterate(initial)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      try { setWikiJob(await wikiCall('GET')) } catch { /* preserve checkpoint display */ }
    } finally { setBusy(false) }
  }

  const loadSaved = async () => {
    setBusy(true); setError(''); setMessage('')
    try {
      const [saved, publication] = await Promise.all([call('GET'), wikiCall('GET')])
      setJob(saved)
      setWikiJob(publication)
    }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const iterate = async (initial: Job) => {
    let current = initial
    while (current.state === 'running' || current.state === 'paused' || current.state === 'verifying') {
      if (stopRequested.current) {
        if (current.state !== 'verifying') current = await call('POST', { action: 'pause', id: current.id })
        setJob(current)
        setMessage('Paused. Reviewed source summaries are checkpointed; Resume continues from the last completed batch.')
        return
      }
      try {
        current = await call('POST', { action: 'step', id: current.id })
        setJob(current)
      } catch (e) {
        const seconds = (e as { retrySeconds?: number }).retrySeconds
        if (!seconds) throw e
        setMessage(`HedgeDoc API 429: waiting ${seconds}s; completed batches saved. Stop is available.`)
        for (let remaining = seconds; remaining > 0 && !stopRequested.current; remaining -= 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2, remaining) * 1000))
        }
      }
    }
    if (current.state === 'ready') setMessage('All source summaries reviewed and verified. Inspect generated concepts before Apply.')
  }

  const generate = async (resume: boolean) => {
    setBusy(true); setError(''); setMessage(''); setConfirmation('')
    stopRequested.current = false
    try {
      let initial = resume && job?.id ? job : null
      while (!initial && !stopRequested.current) {
        try {
          initial = await call('POST', { action: 'start' })
        } catch (e) {
          const seconds = (e as { retrySeconds?: number }).retrySeconds
          if (!seconds) throw e
          setMessage(`Wiki catalogue API 429: waiting ${seconds}s before starting; Stop available.`)
          for (let remaining = seconds; remaining > 0 && !stopRequested.current; remaining -= 2) {
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2, remaining) * 1000))
          }
        }
      }
      if (!initial) { setMessage('Refresh stopped before starting.'); return }
      setJob(initial)
      await iterate(initial)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      try { setJob(await call('GET')) } catch { /* preserve the last checkpoint shown */ }
    } finally { setBusy(false) }
  }

  const apply = async () => {
    if (!job?.id || job.state !== 'ready' || confirmation !== 'APPLY') return
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await call('POST', { action: 'apply', id: job.id, confirmation })
      setJob(result); setConfirmation('')
      setMessage(`OKF source index saved (${result.sourceSummariesApplied ?? 0} summaries). Preparing Wiki Topic/Entity publication.`)
      const updated = await call('GET')
      setJob(updated)
      publishStop.current = false
      const publication = await wikiCall('POST', { action: 'prepare', confirmation: 'APPLY' })
      setWikiJob(publication)
      await publishIterate(publication)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  const title = (alias: string) =>
    [...(catalogue?.topics ?? []), ...(catalogue?.entities ?? [])]
      .find((p) => p.alias === alias)?.title ?? alias
  const topics = job?.generatedTopics ?? []
  const entities = job?.generatedEntities ?? []
  const pairs = job?.navigationCandidates ?? []
  const needle = filter.trim().toLocaleLowerCase()
  const visible = <T extends { name: string }>(groups: T[]) =>
    groups.filter((g) => !needle || g.name.toLocaleLowerCase().includes(needle)).slice(0, 100)
  const visiblePairs = pairs.filter((p) => !needle ||
    `${p.topic} ${p.entity}`.toLocaleLowerCase().includes(needle)).slice(0, 100)

  return (
    <section aria-label='Automated OKF source-summary refresh' style={{
      border: '1px solid var(--bs-border-color, #ced4da)', borderRadius: 8,
      padding: 16, marginTop: 18, marginBottom: 24,
    }}>
      <h2 style={{ fontSize: 24 }}>OKF source-summary refresh</h2>
      <p>Review <strong>every derived source-summary</strong> with sequential LLM calls to discover
        Topics and Entities across the full evidence catalogue — including new concepts missing
        from the existing Wiki. Preview is read-only. Apply saves the OKF index and publishes NEW
        derived Topic/Entity pages to the maintained Wiki in checkpointed batches. Existing Wiki pages,
        original notes, manually approved <code>associated_with</code> links and Trails remain unchanged.</p>
      <button type='button' onClick={() => void refreshCatalogue().catch((e: unknown) => setError(String(e)))}>
        Refresh Wiki catalogue
      </button>
      <div style={{ marginTop: 8 }}>
        {catalogue ? <>
          <strong>Maintained Wiki pages</strong><br />
          {catalogue.counts?.total ?? 0} derived pages<br />
          <strong>source-summary</strong>: {catalogue.counts?.sourceSummary ?? 0}{' · '}
          <strong>entity</strong>: {catalogue.counts?.entity ?? catalogue.entities.length}{' · '}
          <strong>topic</strong>: {catalogue.counts?.topic ?? catalogue.topics.length}{' · '}
          <strong>comparison</strong>: {catalogue.counts?.comparison ?? 0}{' · '}
          <strong>synthesis</strong>: {catalogue.counts?.synthesis ?? 0}
          <br />{catalogue.relations.length} separately approved Topic–Entity links
        </> : 'Loading Wiki catalogue…'}
      </div>
      {error && <p role='alert' style={{ color: '#b32d2e' }}>{error}</p>}
      {message && <p role='status'>{message}</p>}

      <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 6, marginTop: 12 }}>
        <h3 style={{ fontSize: 18 }}>Automated sequential source-summary review</h3>
        <p>Uses your signed-in HedgeDoc operator session and server-side Memex model settings.
          No browser token is required. Each batch reads four summaries, then classifies them with the LLM. After classification, a checkpointed verification pass checks unchanged source content before Apply.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          <button type='button' disabled={busy} onClick={() => void generate(false)}>Generate sequential preview</button>
          <button type='button' disabled={busy || !job?.id ||
            (job.state !== 'paused' && job.state !== 'running' && job.state !== 'verifying')}
            onClick={() => void generate(true)}>Resume preview</button>
          <button type='button' disabled={!busy}
            onClick={() => { stopRequested.current = true; setMessage('Stopping after the current source batch or verification call…') }}>
            Stop preview
          </button>
          <button type='button' disabled={busy} onClick={() => void loadSaved()}>Load saved preview</button>
        </div>
        <p style={{ marginTop: 10 }}>OKF refresh terminal: {busy ? 'reviewing' : (job?.state ?? 'idle')}</p>
        <pre aria-live='polite' style={{ padding: 12, minHeight: 110, whiteSpace: 'pre-wrap',
          background: '#101010', color: '#f7f7f7', fontSize: 12, borderRadius: 4 }}>
          {job?.available
            ? `Source summaries reviewed: ${job.reviews ?? 0}/${job.sourceSummaries ?? 0}\n` +
              `LLM batches: ${job.step ?? 0}/${job.totalSteps ?? 0}\n` +
              `Source verification: ${job.verified ?? 0}/${job.sourceSummaries ?? 0}\n` +
              `Discovered Topics: ${topics.length}; Entities: ${entities.length}\n` +
              `Source-backed co-occurrence candidates: ${pairs.length}\n` +
              `Rejected unsupported LLM candidates: ${job.rejectedCandidates ?? 0} (from ${(job.flaggedSummaries ?? []).length} source summaries)\n` +
              `Maintained Wiki pages: ${catalogue?.counts?.total ?? 0} derived pages\n` +
              `source-summary: ${catalogue?.counts?.sourceSummary ?? 0} · entity: ${catalogue?.counts?.entity ?? job.wikiEntities ?? 0} · topic: ${catalogue?.counts?.topic ?? job.wikiTopics ?? 0} · comparison: ${catalogue?.counts?.comparison ?? 0} · synthesis: ${catalogue?.counts?.synthesis ?? 0}\n` +
              `Model: ${job.model ?? '(unknown)'}\nState: ${job.state ?? 'unknown'}`
            : 'No source-summary refresh preview loaded.'}
        </pre>
      </div>

      {(job?.rejectedCandidates ?? 0) > 0 && <p role='status' style={{ color: '#945d00' }}>
        Unsupported or malformed model candidates were excluded; review the partial classification before Apply.
      </p>}
      {job?.available && (job.reviews ?? 0) > 0 && <div style={{ border: '1px solid #ddd', padding: 12, marginTop: 12 }}>
        <h3 style={{ fontSize: 18 }}>Source-grounded OKF preview — {job.state === 'applied' ? 'applied' : 'not yet applied'}</h3>
        <p>{job.reviews} source summaries classified. Discovered {topics.length} distinct Topic labels
          and {entities.length} named Entity labels, with {pairs.length} source-level co-occurrence candidates.
          These are <strong>not</strong> automatically verified semantic relations.</p>
        <label>Filter proposed concepts{' '}
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='Search Topic or Entity' />
        </label>
        <div style={{ maxHeight: 460, overflowY: 'auto', marginTop: 12 }}>
          <h4>Topics ({topics.length})</h4>
          <ul>{visible(topics).map((item) => <li key={item.name}>
            <strong>{item.name}</strong> — {item.count} source summaries ·{' '}
            {item.summaries.slice(0, 3).map((alias) => <a key={alias} href={`/n/${alias}`} style={{ marginRight: 6 }}>{alias}</a>)}
          </li>)}</ul>
          <h4>Entities ({entities.length})</h4>
          <ul>{visible(entities).map((item) => <li key={item.name}>
            <strong>{item.name}</strong> — {item.count} source summaries ·{' '}
            {item.summaries.slice(0, 3).map((alias) => <a key={alias} href={`/n/${alias}`} style={{ marginRight: 6 }}>{alias}</a>)}
          </li>)}</ul>
          <h4>Topic → Entity co-occurrences ({pairs.length})</h4>
          <ul>{visiblePairs.map((p) => <li key={`${p.topic}\u0000${p.entity}`}>
            {p.topic} → {p.entity} — {p.count} source summaries ·{' '}
            {p.summaries.slice(0, 3).map((alias) => <a key={alias} href={`/n/${alias}`} style={{ marginRight: 6 }}>{alias}</a>)}
          </li>)}</ul>
        </div>
        {job.state === 'ready' && <div style={{ marginTop: 12 }}>
          <label>Type APPLY to save the navigation index and publish new Topic/Entity pages to /memex-wiki{' '}
            <input value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          </label>{' '}
          <button type='button' disabled={busy || confirmation !== 'APPLY' || !job.ready ||
            !catalogue?.writeEnabled} onClick={() => void apply()}>Apply → memex-wiki</button>
          {!catalogue?.writeEnabled && <p>OKF navigation writes are disabled by the operator.</p>}
        </div>}
      </div>}

      {(job?.state === 'applied' || (job?.approved?.summaries ?? 0) > 0) &&
        <div style={{ border: '1px solid #ddd', padding: 12, borderRadius: 6, marginTop: 14 }}>
          <h3 style={{ fontSize: 18 }}>Apply persisted OKF results → memex-wiki</h3>
          <p>Creates source-grounded <strong>Topic</strong> and <strong>Entity</strong> Wiki pages for missing labels.
            Existing Wiki pages are skipped, never rewritten. All supporting canonical sources stay unchanged.
            Shared-source Topic/Entity links are explicitly labelled <strong>unapproved co-occurrences</strong>. A bounded nodeBook graph page is added to the Wiki index after publication completes.
            Publication is paced to avoid HedgeDoc API 429 and can be resumed after disconnects.</p>
          <pre aria-live='polite' style={{ whiteSpace: 'pre-wrap', padding: 10, background: '#101010', color: '#f7f7f7', borderRadius: 4 }}>
            {wikiJob?.available
              ? `Wiki publication: ${wikiJob.state}\nProcessed: ${wikiJob.processed ?? 0}/${wikiJob.total ?? 0}\nNew pages: ${wikiJob.created ?? 0}\nExisting preserved: ${wikiJob.skippedExisting ?? 0}\nUnpublished conflicts/invalid names: ${wikiJob.rejectedCount ?? 0}\nnodeBook index graph: ${wikiJob.graphState ?? 'pending'}`
              : 'Wiki publication has not started. Existing applied OKF index is available.'}
          </pre>
          {wikiJob?.graphAlias && <p><a href={`/n/${wikiJob.graphAlias}`}>Open index → nodeBook navigation graph</a> · <a href='http://192.168.1.142:8280/memex'>nodeBook workspace</a></p>}
          {wikiJob?.rejected?.length ? <details><summary>Publication exceptions ({wikiJob.rejectedCount})</summary>
            <ul>{wikiJob.rejected.map((text, i) => <li key={i}>{text}</li>)}</ul>
          </details> : null}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {(!wikiJob?.available || wikiJob.state === 'completed') && <>
              <label>Type APPLY to publish new pages{' '}
                <input value={wikiConfirmation} onChange={(e) => setWikiConfirmation(e.target.value)} />
              </label>
              <button type='button' disabled={busy || wikiConfirmation !== 'APPLY' || !catalogue?.writeEnabled}
                onClick={() => void publish(false)}>Apply → memex-wiki</button>
            </>}
            {wikiJob?.available && (wikiJob.state === 'running' || wikiJob.state === 'paused') &&
              <button type='button' disabled={busy} onClick={() => void publish(true)}>Resume Wiki publication</button>}
            <button type='button' disabled={!busy} onClick={() => {
              publishStop.current = true
              setMessage('Stopping Wiki publication after this batch; progress is saved.')
            }}>Stop Wiki publication</button>
            <button type='button' disabled={busy} onClick={() => void wikiCall('GET')
              .then(setWikiJob).catch((e: unknown) => setError(String(e)))}>Load publication progress</button>
          </div>
        </div>}

      {job?.approved && <p style={{ marginTop: 14 }}>
        <strong>Persisted OKF source index:</strong> {job.approved.summaries} source summaries,
        {' '}{job.approved.topics} Topics, {job.approved.entities} Entities,
        {' '}{job.approved.cooccurrences} co-occurrence candidates
        {job.approved.updatedAt ? ` (updated ${job.approved.updatedAt})` : ''}.
      </p>}
      {catalogue && <div style={{ marginTop: 16 }}>
        <h3 style={{ fontSize: 18 }}>Separately approved Wiki Topic → Entity links</h3>
        {catalogue.relations.length ? <ul>{catalogue.relations.map((r) => <li key={`${r.topicAlias}:${r.entityAlias}`}>
          <a href={`/n/${r.topicAlias}`}>{title(r.topicAlias)}</a>{' → '}
          <a href={`/n/${r.entityAlias}`}>{title(r.entityAlias)}</a>{' — '}{r.rationale}
        </li>)}</ul> : <p>No individual Wiki Topic–Entity links approved yet.</p>}
      </div>}
    </section>
  )
}
