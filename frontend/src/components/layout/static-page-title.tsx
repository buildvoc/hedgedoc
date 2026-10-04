'use client'

/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useAppTitle } from '../../hooks/common/use-app-title'
import { usePathname, useSearchParams } from 'next/navigation'
import { useEffect } from 'react'

const pageTitles: Record<string, string> = {
  '/cheatsheet': 'Cheatsheet',
  '/explore/my': 'Explore - My Notes',
  '/explore/public': 'Explore - Public Notes',
  '/explore/shared': 'Explore - Shared With Me',
  '/explore/visited': 'Explore - Visited Notes',
  '/login': 'Login',
  '/memex-association-review': 'Association Recommendations',
  '/memex-index': 'Memex Index',
  '/memex-log': 'Memex Log',
  '/memex-settings': 'Memex Model Settings',
  '/memex-snapshots': 'Memex Snapshots',
  '/new': 'New Note',
  '/new-user': 'New User',
  '/profile': 'Profile',
  '/split-notes': 'Split Notes',
  '/trails': 'Trail Graph',
  '/user-trails': 'User Trails'
}

/**
 * Sets browser-tab titles for non-note editor pages.
 *
 * Note routes keep their existing useNoteAndAppTitle() behaviour.
 */
export const StaticPageTitle = (): null => {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const appTitle = useAppTitle()
  const pageTitle =
    pathname === '/explore/my' && searchParams?.get('memex') === 'pending'
      ? 'Process Pending'
      : pathname
        ? pageTitles[pathname]
        : undefined

  useEffect(() => {
    if (pageTitle) {
      document.title = `${pageTitle} | ${appTitle}`
    }
  }, [appTitle, pageTitle])

  return null
}
