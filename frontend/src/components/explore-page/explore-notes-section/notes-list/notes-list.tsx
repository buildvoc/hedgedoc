'use client'
/*
 * SPDX-FileCopyrightText: 2025 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteExploreEntryInterface, NoteType, SortMode } from '@hedgedoc/commons'
import { Mode } from '../../mode-selection/mode'
import { getExplorePageEntries } from '../../../../api/explore'
import { NoteListEntry } from './note-entry'
import { Trans } from 'react-i18next'
import InfiniteScroll from 'react-infinite-scroll-component'
import { useUiNotifications } from '../../../notifications/ui-notification-boundary'
import { useApplicationState } from '../../../../hooks/common/use-application-state'
import equal from 'fast-deep-equal'
import styles from './note-entry.module.css'
import { RateLimitError } from '../../../../api/common/api-error'

export interface NotesListProps {
  mode: Mode
  sort: SortMode
  searchFilter: string | null
  typeFilter: NoteType | null
  memexQueueOnly?: boolean
  tagFilter?: string[]
  snapshotSelectedAliases?: Set<string>
  onSnapshotSelectionChange?: (alias: string, title: string, selected: boolean) => void
}

/**
 * Renders the infinite scroll list of notes matching the given filter criteria.
 *
 * @param mode The access mode to use, for example whether to show only recently visited notes or all public notes.
 * @param sort The sorting mode to use, for example whether to sort by last changed date or by title.
 * @param searchFilter An optional search filter to apply, e.g. to filter for notes containing a specific string.
 * @param typeFilter An optional note type filter to apply, e.g. to show only documents or only slides.
 */
export const NotesList: React.FC<NotesListProps> = ({
  mode,
  sort,
  searchFilter,
  typeFilter,
  memexQueueOnly = false,
  tagFilter = [],
  snapshotSelectedAliases = new Set(),
  onSnapshotSelectionChange
}) => {
  const [entries, setEntries] = useState<NoteExploreEntryInterface[]>([])
  const [memexPendingAliases, setMemexPendingAliases] = useState<Set<string>>(new Set())
  const { showErrorNotificationBuilder, dispatchUiNotification } = useUiNotifications()
  const [moreDataAvailable, setMoreDataAvailable] = useState(true)
  const lastPage = useRef<number>(0)
  const lastFilters = useRef({})
  const selectionAnchorAlias = useRef<string | null>(null)
  const pinnedNotes = useApplicationState((state) => state.pinnedNotes)

  // Load pending Memex aliases only when the filter is active.
  useEffect(() => {
    if (!memexQueueOnly) {
      setMemexPendingAliases(new Set())
      return
    }

    let cancelled = false

    void fetch('/memex-queue?q=', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Memex queue HTTP ${response.status}`)
        return response.json()
      })
      .then((data: { items?: Array<{ alias: string; status: string }> }) => {
        if (cancelled) return
        setMemexPendingAliases(
          new Set((data.items ?? []).filter((item) => item.status === 'pending').map((item) => item.alias))
        )
      })
      .catch(() => {
        if (!cancelled) setMemexPendingAliases(new Set())
      })

    return () => {
      cancelled = true
    }
  }, [memexQueueOnly])

  const fetchNextPage = useCallback(
    (replaceOldEntries: boolean = false) => {
      lastFilters.current = { mode, sort, searchFilter, typeFilter }

      lastPage.current += 1
      getExplorePageEntries(mode, sort, searchFilter, typeFilter, lastPage.current, tagFilter)
        .then((data) => {
          if (data.length === 0) {
            setMoreDataAvailable(false)
            if (replaceOldEntries) {
              setEntries([])
            }
            return
          }
          if (replaceOldEntries) {
            setEntries(data)
          } else {
            setEntries((prev) => [...prev, ...data])
          }
        })
        .catch((error: unknown) => {
          if (error instanceof RateLimitError) {
            dispatchUiNotification('errors.rateLimitExceeded.title', 'errors.rateLimitExceeded.description', {
              contentI18nOptions: {
                resetIn: error.getResetIn()
              }
            })
            return
          }
          showErrorNotificationBuilder('explore.errorLoadingEntries')(error as Error)
        })
    },
    [mode, sort, searchFilter, typeFilter, tagFilter, showErrorNotificationBuilder, dispatchUiNotification]
  )

  const updateExplorePage = useCallback(() => {
    lastPage.current = 0
    setMoreDataAvailable(true)
    fetchNextPage(true)
  }, [setMoreDataAvailable, fetchNextPage])

  // When showing the Memex queue, pending notes may live on later Explore
  // pages. Keep loading pages until every pending alias has been found, or
  // until the normal Explore API reports that there are no more pages.
  useEffect(() => {
    if (!memexQueueOnly || memexPendingAliases.size === 0 || !moreDataAvailable) {
      return
    }

    const loadedAliases = new Set(entries.map((note) => note.primaryAlias))
    const missingPendingAliases = [...memexPendingAliases].filter((alias) => !loadedAliases.has(alias))

    if (missingPendingAliases.length > 0) {
      fetchNextPage()
    }
  }, [memexQueueOnly, memexPendingAliases, entries, moreDataAvailable, fetchNextPage])

  const selectableEntries = useMemo(
    () => entries.filter((note) => !memexQueueOnly || memexPendingAliases.has(note.primaryAlias)),
    [entries, memexQueueOnly, memexPendingAliases],
  )

  const handleSnapshotSelectionChange = useCallback(
    (alias: string, title: string, selected: boolean, shiftKey: boolean) => {
      if (!onSnapshotSelectionChange) {
        return
      }

      const anchorAlias = selectionAnchorAlias.current
      if (shiftKey && anchorAlias) {
        const anchorIndex = selectableEntries.findIndex((note) => note.primaryAlias === anchorAlias)
        const currentIndex = selectableEntries.findIndex((note) => note.primaryAlias === alias)

        if (anchorIndex >= 0 && currentIndex >= 0) {
          const start = Math.min(anchorIndex, currentIndex)
          const end = Math.max(anchorIndex, currentIndex)

          for (const note of selectableEntries.slice(start, end + 1)) {
            onSnapshotSelectionChange(note.primaryAlias, note.title, selected)
          }

          selectionAnchorAlias.current = alias
          return
        }
      }

      onSnapshotSelectionChange(alias, title, selected)
      selectionAnchorAlias.current = alias
    },
    [onSnapshotSelectionChange, selectableEntries],
  )

  const noteEntries = useMemo(() => {
    return selectableEntries
      .map((note) => {
        const isPinned = pinnedNotes[note.primaryAlias] !== undefined
        return (
          <NoteListEntry
            {...note}
            key={note.primaryAlias}
            isPinned={isPinned}
            showLastVisitedTime={mode === Mode.VISITED}
            updateExplorePage={updateExplorePage}
            showMemexQueueAction={mode === Mode.MY_NOTES}
            showMemexRemoveAction={memexQueueOnly}
            onMemexQueueRemoved={() =>
              setMemexPendingAliases((current) => {
                const next = new Set(current)
                next.delete(note.primaryAlias)
                return next
              })
            }
            snapshotSelected={snapshotSelectedAliases.has(note.primaryAlias)}
            onSnapshotSelectionChange={
              onSnapshotSelectionChange
                ? (selected, shiftKey) =>
                    handleSnapshotSelectionChange(
                      note.primaryAlias,
                      note.title,
                      selected,
                      shiftKey,
                    )
                : undefined
            }
          />
        )
      })
  }, [
    selectableEntries,
    mode,
    pinnedNotes,
    updateExplorePage,
    memexQueueOnly,
    memexPendingAliases,
    snapshotSelectedAliases,
    onSnapshotSelectionChange,
    handleSnapshotSelectionChange
  ])

  // Update entries when filters change
  useEffect(() => {
    if (!equal(lastFilters.current, { mode, sort, searchFilter, typeFilter })) {
      updateExplorePage()
    }
  }, [updateExplorePage, mode, sort, searchFilter, typeFilter])

  return (
    <InfiniteScroll
      className={styles['infinite-scroll']}
      dataLength={entries.length}
      next={fetchNextPage}
      hasMore={moreDataAvailable}
      loader={
        <div className={'text-center fs-3'}>
          <Trans i18nKey={'explore.loadingMore'} />
        </div>
      }
      endMessage={
        <div className={'text-center fs-4 mt-4'}>
          <p>
            <Trans i18nKey={'explore.noMoreNotesFound'} />
          </p>
        </div>
      }>
      {noteEntries}
    </InfiniteScroll>
  )
}
