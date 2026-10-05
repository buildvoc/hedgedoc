import '../../../global-styles/index.scss'

import type { Metadata, Viewport } from 'next'
import type { PropsWithChildren } from 'react'

export default function MemexChatLayout({ children }: PropsWithChildren) {
  return (
    <html lang='en'>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          background: 'var(--bs-body-bg, #fff)',
          color: 'var(--bs-body-color, #212529)',
        }}>
        {children}
      </body>
    </html>
  )
}

export const metadata: Metadata = {
  applicationName: 'HedgeDoc Memex',
  description: 'Dedicated Memex Wiki Chat',
  title: 'Memex Wiki Chat',
}

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
}
