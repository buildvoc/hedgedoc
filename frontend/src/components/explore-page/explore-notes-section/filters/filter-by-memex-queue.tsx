/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import React from 'react'
import { Button, Dropdown } from 'react-bootstrap'
import { UiIcon } from '../../../common/icons/ui-icon'
import { Diagram3 as IconMemex } from 'react-bootstrap-icons'

export interface FilterByMemexQueueProps {
  active: boolean
  onChange: (active: boolean) => void
  asMenuItem?: boolean
}

export const FilterByMemexQueue: React.FC<FilterByMemexQueueProps> = ({
  active,
  onChange,
  asMenuItem = false
}) => {
  if (asMenuItem) {
    return (
      <Dropdown.Item active={active} onClick={() => onChange(!active)}>
        <UiIcon icon={IconMemex} />
        <span className='ms-2'>Memex Queue</span>
      </Dropdown.Item>
    )
  }

  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      title='Show notes pending in the Memex queue'
      onClick={() => onChange(!active)}>
      <UiIcon icon={IconMemex} />
      <span className='ms-1'>Memex Queue</span>
    </Button>
  )
}
