'use client'

import { useEffect, useMemo, useState } from 'react'

type WikiIndexEntry = {
  alias: string
  pageType: string
  title: string
  description?: string
}

type WikiCatalogueResponse = {
  indexAlias?: string
  count?: number
  pages?: WikiIndexEntry[]
  error?: string
}

const PAGE_TYPES = [
  'all',
  'source-summary',
  'entity',
  'topic',
  'comparison',
  'synthesis',
] as const

export const MemexWikiCatalogue = () => {
  const [pages, setPages] = useState<WikiIndexEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [pageType, setPageType] = useState<(typeof PAGE_TYPES)[number]>('all')
  const [copiedAlias, setCopiedAlias] = useState('')

  const loadCatalogue = async () => {
    setLoading(true)
    setError('')

    try {
      const response = await fetch('/memex-wiki-maintain', {
        method: 'GET',
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => null)) as WikiCatalogueResponse | null

      if (!response.ok) {
        throw new Error(
          body?.error ??
            `Memex wiki catalogue request failed with HTTP ${response.status}`,
        )
      }

      if (!Array.isArray(body?.pages)) {
        throw new Error('Memex wiki catalogue returned no pages array')
      }

      setPages(body.pages)
    } catch (cause) {
      setPages([])
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadCatalogue()
  }, [])

  const counts = useMemo(() => {
    const values = new Map<string, number>()
    for (const page of pages) {
      values.set(page.pageType, (values.get(page.pageType) ?? 0) + 1)
    }
    return values
  }, [pages])

  const visiblePages = useMemo(() => {
    const needle = query.trim().toLowerCase()

    return pages
      .filter((page) => pageType === 'all' || page.pageType === pageType)
      .filter((page) => {
        if (!needle) return true
        return (
          page.title.toLowerCase().includes(needle) ||
          page.alias.toLowerCase().includes(needle) ||
          page.pageType.toLowerCase().includes(needle) ||
          (page.description ?? '').toLowerCase().includes(needle)
        )
      })
      .sort((a, b) => {
        const typeOrder = a.pageType.localeCompare(b.pageType)
        return typeOrder !== 0 ? typeOrder : a.title.localeCompare(b.title)
      })
  }, [pageType, pages, query])

  const copyAlias = async (alias: string) => {
    try {
      await navigator.clipboard.writeText(alias)
      setCopiedAlias(alias)
      window.setTimeout(() => setCopiedAlias(''), 1500)
    } catch {
      setCopiedAlias('')
    }
  }

  return (
    <section
      aria-label='Maintained Memex wiki catalogue'
      style={{
        border: '1px solid var(--bs-border-color, #ced4da)',
        borderRadius: '0.5rem',
        padding: '1rem',
        marginTop: '1rem',
      }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: '0.75rem',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}>
        <div>
          <h2 style={{ fontSize: '1.1rem', margin: 0 }}>Maintained wiki pages</h2>
          <p style={{ margin: '0.35rem 0 0' }}>
            {loading ? 'Loading catalogue…' : `${pages.length} derived pages`}
          </p>
        </div>

        <button type='button' onClick={() => void loadCatalogue()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <p role='alert' style={{ marginTop: '0.75rem' }}>
          {error}
        </p>
      ) : null}

      {!loading && !error ? (
        <>
          <div
            style={{
              display: 'flex',
              gap: '0.5rem',
              flexWrap: 'wrap',
              marginTop: '0.75rem',
            }}>
            {PAGE_TYPES.slice(1).map((type) => (
              <span key={type}>
                <strong>{type}</strong>: {counts.get(type) ?? 0}
              </span>
            ))}
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(12rem, 1fr) minmax(10rem, 14rem)',
              gap: '0.75rem',
              marginTop: '0.9rem',
            }}>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder='Search title, alias, type or description'
              aria-label='Search maintained wiki pages'
            />

            <select
              value={pageType}
              onChange={(event) =>
                setPageType(event.target.value as (typeof PAGE_TYPES)[number])
              }
              aria-label='Filter maintained wiki pages by type'>
              {PAGE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type === 'all' ? 'All page types' : type}
                </option>
              ))}
            </select>
          </div>

          <p style={{ margin: '0.75rem 0 0.35rem' }}>
            Showing {visiblePages.length} of {pages.length}
          </p>

          <div
            style={{
              borderTop: '1px solid var(--bs-border-color, #ced4da)',
              maxHeight: '32rem',
              overflowY: 'auto',
            }}>
            {visiblePages.map((page) => (
              <article
                key={page.alias}
                style={{
                  padding: '0.75rem 0',
                  borderBottom: '1px solid var(--bs-border-color, #ced4da)',
                }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    alignItems: 'flex-start',
                    flexWrap: 'wrap',
                  }}>
                  <div style={{ minWidth: 0, flex: '1 1 28rem' }}>
                    <div>
                      <strong>{page.title}</strong>{' '}
                      <span>— {page.pageType}</span>
                    </div>
                    {page.description ? (
                      <p style={{ margin: '0.25rem 0' }}>{page.description}</p>
                    ) : null}
                    <code style={{ overflowWrap: 'anywhere' }}>{page.alias}</code>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      gap: '0.5rem',
                      flexWrap: 'wrap',
                    }}>
                    <a
                      href={`/n/${encodeURIComponent(page.alias)}`}
                      target='_blank'
                      rel='noreferrer'>
                      Open
                    </a>
                    <button type='button' onClick={() => void copyAlias(page.alias)}>
                      {copiedAlias === page.alias ? 'Copied' : 'Copy alias'}
                    </button>
                  </div>
                </div>
              </article>
            ))}

            {visiblePages.length === 0 ? (
              <p style={{ padding: '0.75rem 0', margin: 0 }}>
                No maintained wiki pages match this filter.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  )
}
