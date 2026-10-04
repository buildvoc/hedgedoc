/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import React, { useCallback, useState } from 'react'
import { Dropdown } from 'react-bootstrap'
import { Diagram3 as IconMemex, Check2 as IconCheck } from 'react-bootstrap-icons'
import { UiIcon } from '../../../common/icons/ui-icon'

export interface AddToMemexQueueMenuEntryProps {
  noteAlias: string
}

export const AddToMemexQueueMenuEntry: React.FC<AddToMemexQueueMenuEntryProps> = ({
  noteAlias
}) => {
  const [queued, setQueued] = useState(false)
  const [busy, setBusy] = useState(false)

  const onClick = useCallback(() => {
    if (busy || queued) {
      return
    }

    setBusy(true)

    void fetch('/memex-queue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        alias: noteAlias
      })
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Memex queue HTTP ${response.status}`)
        }
        setQueued(true)
      })
      .catch((error) => {
        console.error('Failed to add note to Memex queue:', error)
      })
      .finally(() => {
        setBusy(false)
      })
  }, [noteAlias, busy, queued])

  return (
    <Dropdown.Item onClick={onClick} disabled={busy || queued}>
      <UiIcon icon={queued ? IconCheck : IconMemex} className='mx-2' />
      {busy ? 'Adding to Queue…' : queued ? 'Added to Queue' : 'Add to Queue'}
    </Dropdown.Item>
  )
}
