'use client'

import React, { useState } from 'react'
import { Button } from 'react-bootstrap'
import { Camera as IconCamera } from 'react-bootstrap-icons'

interface SnapshotResponse {
  created?: boolean
  error?: string
  sourceCount?: number
  snapshotRevision?: string
}

export const MemexCreateSnapshotButton: React.FC = () => {
  const [creating, setCreating] = useState(false)

  const createSnapshot = async () => {
    if (creating) return

    const defaultName = `Memex ${new Date().toLocaleString()}`
    const requestedName = window.prompt('Snapshot name', defaultName)

    if (requestedName === null) return

    const name = requestedName.trim()
    if (!name) return

    setCreating(true)

    try {
      const response = await fetch('/memex-snapshot', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      })

      const result = (await response.json()) as SnapshotResponse

      if (!response.ok || !result.created) {
        throw new Error(result.error || `Snapshot HTTP ${response.status}`)
      }

      window.alert(
        `Snapshot created with ${result.sourceCount ?? 0} source${result.sourceCount === 1 ? '' : 's'}.`,
      )
      window.location.reload()
    } catch (error) {
      window.alert(
        error instanceof Error ? error.message : 'Unable to create Memex snapshot',
      )
      setCreating(false)
    }
  }

  return (
    <Button
      aria-label='Create Memex source snapshot'
      disabled={creating}
      onClick={() => void createSnapshot()}
      size='sm'
      variant='primary'
    >
      <IconCamera className='me-1' />
      {creating ? 'Creating…' : 'Create Snapshot'}
    </Button>
  )
}
