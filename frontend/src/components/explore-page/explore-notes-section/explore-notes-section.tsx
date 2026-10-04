'use client'
/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import React, { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Mode } from '../mode-selection/mode'
import type { NoteType } from '@hedgedoc/commons'
import { FilterByNoteType } from './filters/filter-by-note-type'
import { FilterBySearchTerm } from './filters/filter-by-search-term'
import { MemexActionsMenu } from './filters/memex-actions-menu'
import { ExtendSnapshotButton } from './filters/extend-snapshot-button'
import { AddSelectedToMemexQueueButton } from './filters/add-selected-to-memex-queue-button'
import { useUrlParamState } from '../../../hooks/common/use-url-param-state'
import { SortButton } from './filters/sort-button'
import { NotesList } from './notes-list/notes-list'
import { SortMode } from '@hedgedoc/commons'
import { ModeSelection } from '../mode-selection/mode-selection'
import styles from './explore-notes-section.module.css'

export interface ExploreNotesSectionProps {
  mode: Mode
}

/**
 * Renders the section that shows the notes of the explore page.
 *
 * @param mode The current mode of the explore page, for example to show public notes or own notes.
 */
export const ExploreNotesSection: React.FC<ExploreNotesSectionProps> = ({ mode }) => {
  const [searchFilter, setSearchFilter] = useUrlParamState<string | null>('search', null)
  const [tagFilterParam, setTagFilterParam] = useUrlParamState<string | null>('tags', null)
  const [sortMode, setSortMode] = useUrlParamState<SortMode>(
    'sort',
    mode === Mode.VISITED ? SortMode.LAST_VISITED_DESC : SortMode.UPDATED_AT_DESC
  )
  const [filterByType, setFilterByType] = useUrlParamState<NoteType | null>('type', null)
  const [memexFilter, setMemexFilter] = useUrlParamState<string | null>('memex', null)
  const previousMode = useRef<Mode>(mode)
  const [snapshotSelectedNotes, setSnapshotSelectedNotes] = useState<Map<string, string>>(new Map())

  const tagFilter = useMemo(
    () =>
      (tagFilterParam ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    [tagFilterParam]
  )

  const setTagFilter = useCallback(
    (tags: string[]) => {
      setTagFilterParam(tags.length > 0 ? tags.join(',') : null)
    },
    [setTagFilterParam]
  )

  const selectedSnapshotNotes = useMemo(
    () => [...snapshotSelectedNotes.entries()].map(([alias, title]) => ({ alias, title })),
    [snapshotSelectedNotes]
  )

  const setSnapshotNoteSelected = useCallback((alias: string, title: string, selected: boolean) => {
    setSnapshotSelectedNotes((current) => {
      const next = new Map(current)
      if (selected) {
        next.set(alias, title)
      } else {
        next.delete(alias)
      }
      return next
    })
  }, [])

  const clearSnapshotSelection = useCallback(() => {
    setSnapshotSelectedNotes(new Map())
  }, [])

  // Reset filters when mode/page changes
  useEffect(() => {
    if (previousMode.current !== mode) {
      setSearchFilter(null)
      setTagFilterParam(null)
      setSortMode(mode === Mode.VISITED ? SortMode.LAST_VISITED_DESC : SortMode.UPDATED_AT_DESC)
      setFilterByType(null)
      setMemexFilter(null)
      setSnapshotSelectedNotes(new Map())
      previousMode.current = mode
    }
  }, [mode, setFilterByType, setSearchFilter, setSortMode, setTagFilterParam])

  return (
    <Fragment>
      <div className={styles['filter-and-nav-box']}>
        <div className={styles['mode-and-tools']}>
          <ModeSelection />
          <MemexActionsMenu
            mode={mode}
            memexQueueActive={memexFilter === 'pending'}
            onMemexQueueChange={(active) => setMemexFilter(active ? 'pending' : null)}
            tagFilter={tagFilter}
            onTagFilterChange={setTagFilter}
            sort={sortMode}
            searchFilter={searchFilter}
            typeFilter={filterByType}
          />
          {mode === Mode.MY_NOTES && (
            <>
              <AddSelectedToMemexQueueButton
                selectedNotes={selectedSnapshotNotes}
                onClearSelection={clearSnapshotSelection}
              />
              <ExtendSnapshotButton
                selectedNotes={selectedSnapshotNotes}
                onClearSelection={clearSnapshotSelection}
              />
            </>
          )}
        </div>
        <search className={'d-flex gap-2 mb-2'}>
          <FilterByNoteType value={filterByType} onChange={setFilterByType} />
          <FilterBySearchTerm value={searchFilter} onChange={setSearchFilter} />
          <SortButton selected={sortMode} onChange={setSortMode} showLastVisitedOptions={mode === Mode.VISITED} />
        </search>
      </div>
      <NotesList
        key={`${mode}:${tagFilterParam ?? ''}`}
        mode={mode}
        sort={sortMode}
        searchFilter={searchFilter}
        typeFilter={filterByType}
        memexQueueOnly={mode === Mode.MY_NOTES && memexFilter === 'pending'}
        tagFilter={mode === Mode.MY_NOTES ? tagFilter : []}
        snapshotSelectedAliases={new Set(snapshotSelectedNotes.keys())}
        onSnapshotSelectionChange={
          mode === Mode.MY_NOTES ? setSnapshotNoteSelected : undefined
        }
      />
    </Fragment>
  )
}
