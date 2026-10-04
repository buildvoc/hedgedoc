'use client'

import React, { useCallback, useState } from 'react'
import { Dropdown, Spinner } from 'react-bootstrap'

interface Props {
  noteAlias: string
  onRemoved: () => void
}

type State = 'idle' | 'removing' | 'error'

export const RemoveFromMemexQueueMenuEntry: React.FC<Props> = ({
  noteAlias,
  onRemoved
}) => {
  const [state, setState] = useState<State>('idle')

  const remove = useCallback(async () => {
    setState('removing')

    try {
      const response = await fetch('/memex-queue', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          alias: noteAlias
        })
      })

      if (!response.ok) {
        throw new Error(
          `Memex queue returned HTTP ${response.status}`
        )
      }

      onRemoved()
    } catch (error) {
      console.error(
        'Failed to remove note from Memex queue',
        error
      )
      setState('error')
    }
  }, [noteAlias, onRemoved])

  return (
    <Dropdown.Item
      disabled={state === 'removing'}
      className={state === 'error' ? 'text-danger' : undefined}
      onClick={() => void remove()}>
      {state === 'removing' && (
        <Spinner
          animation='border'
          size='sm'
          className='me-2'
        />
      )}
      {state === 'error'
        ? 'Remove failed — retry'
        : state === 'removing'
          ? 'Removing…'
          : 'Remove from Queue'}
    </Dropdown.Item>
  )
}
