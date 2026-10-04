'use client'

import { useCallback, useEffect, useState } from 'react'

interface Props {
  alias?: string | null
  sourceUpdatedAt?: string | null
}

interface QueueItem {
  id: string
  alias: string
  status: string
  queuedAt: string
}

export const MemexQueueButton = ({ alias, sourceUpdatedAt }: Props) => {
  const [items, setItems] = useState<QueueItem[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)

  const loadQueue = useCallback(async (q = '') => {
    const r = await fetch(`/memex-queue?q=${encodeURIComponent(q)}`, {
      cache: 'no-store'
    })
    if (!r.ok) return
    const data = await r.json()
    setItems(data.items ?? [])
  }, [])

  useEffect(() => {
    void loadQueue()
  }, [loadQueue])

  const pending = items.filter((x) => x.status === 'pending')
  const currentPending = pending.some((x) => x.alias === alias)

  const add = async () => {
    if (!alias) return
    setBusy(true)
    await fetch('/memex-queue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias, sourceUpdatedAt })
    })
    await loadQueue(query)
    setBusy(false)
  }

  const remove = async (targetAlias: string) => {
    setBusy(true)
    await fetch('/memex-queue', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: targetAlias })
    })
    await loadQueue(query)
    setBusy(false)
  }

  return (
    <div className='d-flex align-items-center ms-2 position-relative'>
      <button
        className='btn btn-sm btn-outline-secondary'
        disabled={!alias || currentPending || busy}
        onClick={() => void add()}>
        + Memex
      </button>

      <button
        className='btn btn-sm btn-outline-danger ms-1'
        disabled={!alias || !currentPending || busy}
        onClick={() => alias && void remove(alias)}>
        −
      </button>

      <button
        className='btn btn-sm btn-outline-secondary ms-1'
        onClick={() => {
          setOpen((v) => !v)
          void loadQueue(query)
        }}>
        Queue ({pending.length})
      </button>

      {open && (
        <div
          className='position-absolute bg-body border rounded shadow p-2'
          style={{
            top: 'calc(100% + 6px)',
            right: 0,
            width: '440px',
            maxHeight: '420px',
            overflowY: 'auto',
            zIndex: 3000
          }}>

          <input
            className='form-control form-control-sm mb-2'
            placeholder='Search queue…'
            value={query}
            onChange={(e) => {
              const q = e.target.value
              setQuery(q)
              void loadQueue(q)
            }}
          />

          <div className='small fw-bold mb-1'>
            Pending queue: {pending.length}
          </div>

          {items.length === 0 && (
            <div className='small text-muted'>Queue empty</div>
          )}

          {items.map((item) => (
            <div
              key={item.id}
              className='d-flex justify-content-between align-items-center border-bottom py-2'>
              <div className='small text-truncate me-2'>
                <div><strong>{item.alias}</strong></div>
                <div className='text-muted'>{item.status}</div>
              </div>

              {item.status === 'pending' && (
                <button
                  className='btn btn-sm btn-outline-danger'
                  disabled={busy}
                  onClick={() => void remove(item.alias)}>
                  −
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
