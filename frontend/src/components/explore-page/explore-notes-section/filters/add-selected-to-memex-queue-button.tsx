'use client'
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import React, { useCallback, useMemo, useState } from 'react'
import { Button } from 'react-bootstrap'
import { Diagram3 as IconMemex } from 'react-bootstrap-icons'
import { UiIcon } from '../../../common/icons/ui-icon'

interface SelectedNote {
  alias: string
  title: string
}

interface AddSelectedToMemexQueueButtonProps {
  selectedNotes: SelectedNote[]
  onClearSelection: () => void
}

const MAX_QUEUE_SELECTION = 4

export const AddSelectedToMemexQueueButton: React.FC<AddSelectedToMemexQueueButtonProps> = ({
  selectedNotes,
  onClearSelection,
}) => {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const uniqueNotes = useMemo(
    () => [...new Map(selectedNotes.map((note) => [note.alias, note])).values()],
    [selectedNotes],
  )
  const overLimit = uniqueNotes.length > MAX_QUEUE_SELECTION

  const addSelected = useCallback(async () => {
    if (busy || uniqueNotes.length === 0 || overLimit) {
      return
    }

    setBusy(true)
    setError(null)

    try {
      const response = await fetch('/memex-queue', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          aliases: uniqueNotes.map((note) => note.alias),
        }),
      })

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { error?: string }
          | null
        setError(data?.error ?? `Memex queue HTTP ${response.status}`)
        return
      }

      onClearSelection()
    } catch {
      setError('Failed to add selected notes to the Memex queue')
    } finally {
      setBusy(false)
    }
  }, [busy, onClearSelection, overLimit, uniqueNotes])

  const label = busy
    ? `Adding to Queue… (${uniqueNotes.length}/${MAX_QUEUE_SELECTION})`
    : overLimit
      ? `Add to Queue (${uniqueNotes.length}; max ${MAX_QUEUE_SELECTION})`
      : `Add to Queue (${uniqueNotes.length}/${MAX_QUEUE_SELECTION})`

  return (
    <div className='d-flex align-items-center gap-2'>
      <Button
        variant='success'
        disabled={busy || uniqueNotes.length === 0 || overLimit}
        title={
          overLimit
            ? `Select a maximum of ${MAX_QUEUE_SELECTION} notes before adding to the Memex queue`
            : `Add up to ${MAX_QUEUE_SELECTION} selected notes to the Memex queue`
        }
        onClick={() => void addSelected()}>
        <UiIcon icon={IconMemex} />
        <span className='ms-1'>{label}</span>
      </Button>
      {error && <span className='small text-danger'>{error}</span>}
    </div>
  )
}
