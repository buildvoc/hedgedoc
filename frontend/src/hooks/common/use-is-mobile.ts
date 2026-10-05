/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useSyncExternalStore } from 'react'

const MOBILE_MEDIA_QUERY = '(max-width: 767.98px)'

const subscribe = (onStoreChange: () => void): (() => void) => {
  const mediaQuery = window.matchMedia(MOBILE_MEDIA_QUERY)
  mediaQuery.addEventListener('change', onStoreChange)
  return () => mediaQuery.removeEventListener('change', onStoreChange)
}

const getSnapshot = (): boolean => window.matchMedia(MOBILE_MEDIA_QUERY).matches
const getServerSnapshot = (): boolean => false

/**
 * Returns true when the interface is at the same phone-width breakpoint used by nodeBook.
 */
export const useIsMobile = (): boolean => useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
