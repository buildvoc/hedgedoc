'use client'

/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteType, SortMode } from '@hedgedoc/commons'
import React from 'react'
import { Dropdown } from 'react-bootstrap'
import { List as IconMenu } from 'react-bootstrap-icons'
import { UiIcon } from '../../../common/icons/ui-icon'
import { Mode } from '../../mode-selection/mode'
import { BatchUserTrailButton } from './batch-user-trail-button'
import { FilterByMemexQueue } from './filter-by-memex-queue'
import { ProcessMemexQueueButton } from './process-memex-queue-button'
import { ResetMemexPendingButton } from './reset-memex-pending-button'
import { FilterByTags } from './filter-by-tags'
import styles from './memex-actions-menu.module.css'

interface MemexActionsMenuProps {
  mode: Mode
  memexQueueActive: boolean
  onMemexQueueChange: (active: boolean) => void
  tagFilter: string[]
  onTagFilterChange: (tags: string[]) => void
  sort: SortMode
  searchFilter: string | null
  typeFilter: NoteType | null
}

/**
 * Groups HedgeDoc-only Memex and trail controls behind one compact menu so the
 * primary Explore filter row stays aligned with nodeBook.
 */
export const MemexActionsMenu: React.FC<MemexActionsMenuProps> = ({
  mode,
  memexQueueActive,
  onMemexQueueChange,
  tagFilter,
  onTagFilterChange,
  sort,
  searchFilter,
  typeFilter
}) => {
  return (
    <Dropdown autoClose='outside'>
      <Dropdown.Toggle
        size='sm'
        variant='outline-secondary'
        title='Memex and trail tools'
        aria-label='Memex and trail tools'>
        <UiIcon icon={IconMenu} />
      </Dropdown.Toggle>

      <Dropdown.Menu align='end' className={styles.menu}>
        {mode === Mode.MY_NOTES && (
          <>
            <FilterByMemexQueue
              active={memexQueueActive}
              onChange={onMemexQueueChange}
              asMenuItem
            />
            {memexQueueActive && (
              <>
                <ProcessMemexQueueButton asMenuItem />
                <ResetMemexPendingButton />
                <Dropdown.Item href='/memex-index'>Index</Dropdown.Item>
                <Dropdown.Item href='/memex-log'>Log</Dropdown.Item>
              </>
            )}
            <Dropdown.Divider />
          </>
        )}

        <Dropdown.Item href='/user-trails'>User Trails</Dropdown.Item>
        <Dropdown.Item href='/split-notes'>LLM Split</Dropdown.Item>
        <Dropdown.Item href='/trails'>Trail Graph</Dropdown.Item>

        {mode === Mode.MY_NOTES && (
          <>
            <Dropdown.Divider />
            <BatchUserTrailButton
              mode={mode}
              sort={sort}
              searchFilter={searchFilter}
              typeFilter={typeFilter}
              asMenuItem
            />
            <Dropdown.Divider />
            <Dropdown.Header>Filter by tags</Dropdown.Header>
            <div className={styles.tagFilter}>
              <FilterByTags
                typeFilter={typeFilter}
                value={tagFilter}
                onChange={onTagFilterChange}
              />
            </div>
          </>
        )}
      </Dropdown.Menu>
    </Dropdown>
  )
}
