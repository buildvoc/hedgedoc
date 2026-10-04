'use client'

import Link from 'next/link'
import React, { useEffect, useState } from 'react'
import { Spinner } from 'react-bootstrap'

interface Item {
  alias: string
  title: string
  summary: string
}

interface Props {
  searchFilter: string | null
}

export const MemexOrphanList: React.FC<Props> = ({ searchFilter }) => {
  const [items, setItems] = useState<Item[] | null>(null)

  useEffect(() => {
    const q = encodeURIComponent(searchFilter ?? '')
    setItems(null)

    void fetch(`/memex-orphans?q=${q}`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((data: { items?: Item[] }) => setItems(data.items ?? []))
  }, [searchFilter])

  if (items === null) return <Spinner animation='border' />

  if (items.length === 0) return <div>No orphan pages.</div>

  return (
    <div className='d-flex flex-column gap-3'>
      {items.map((item) => (
        <div key={item.alias}>
          <Link href={`/n/${item.alias}`} className='fw-semibold'>
            {item.title}
          </Link>
          {item.summary && <div className='text-muted small'>{item.summary}</div>}
        </div>
      ))}
    </div>
  )
}
