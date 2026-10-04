import type { ReactNode } from 'react'

import { MemexIndexRerunSelector } from './memex-index-rerun-selector'

export default function MemexIndexLayout({
  children
}: Readonly<{
  children: ReactNode
}>) {
  return (
    <>
      <MemexIndexRerunSelector />
      {children}
    </>
  )
}
