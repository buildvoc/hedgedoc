import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Memex Wiki Summary Quality Benchmarks',
}

export default function MemexAssociationBenchmarksLayout({
  children,
}: {
  children: ReactNode
}) {
  return children
}
