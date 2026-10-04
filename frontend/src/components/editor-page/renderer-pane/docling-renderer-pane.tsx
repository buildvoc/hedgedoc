/*
 * SPDX-License-Identifier: AGPL-3.0-only
 */
'use client'

import type { DoclingDocument } from './docling-document'
import styles from './docling-renderer-pane.module.scss'
import React, { useEffect, useRef, useState } from 'react'

const DOCLING_COMPONENTS_SRC = 'https://unpkg.com/@docling/docling-components@0.0.7'
const RENDER_DEBOUNCE_MS = 800

type DoclingImgElement = HTMLElement & {
  src: DoclingDocument
}

type RenderState =
  | { status: 'idle'; message: string }
  | { status: 'loading'; message: string }
  | { status: 'ready'; document: DoclingDocument }
  | { status: 'error'; message: string }

let componentLoader: Promise<void> | null = null

const ensureDoclingComponents = (): Promise<void> => {
  if (customElements.get('docling-img')) {
    return Promise.resolve()
  }

  if (componentLoader) {
    return componentLoader
  }

  componentLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.type = 'module'
    script.src = DOCLING_COMPONENTS_SRC
    script.dataset.hedgedocDoclingComponents = 'true'
    script.addEventListener('load', () => {
      void customElements.whenDefined('docling-img').then(() => resolve())
    })
    script.addEventListener('error', () => reject(new Error('Unable to load Docling renderer component.')))
    document.head.appendChild(script)
  })

  return componentLoader
}

export interface DoclingRendererPaneProps {
  document: DoclingDocument | null
}

/**
 * Renders a DoclingDocument using the same docling-img web component used by Docling Serve's UI.
 * The note remains raw JSON in the editor; rendering is performed through the same-origin route.
 */
export const DoclingRendererPane: React.FC<DoclingRendererPaneProps> = ({ document: doclingDocument }) => {
  const viewerHost = useRef<HTMLDivElement>(null)
  const [renderState, setRenderState] = useState<RenderState>(() =>
    doclingDocument
      ? { status: 'loading', message: 'Preparing Docling-Rendered preview…' }
      : { status: 'idle', message: 'Waiting for valid DoclingDocument JSON…' }
  )

  useEffect(() => {
    const controller = new AbortController()

    if (!doclingDocument) {
      setRenderState({ status: 'idle', message: 'Waiting for valid DoclingDocument JSON…' })
      return () => controller.abort()
    }

    const timer = window.setTimeout(() => {
      setRenderState({ status: 'loading', message: 'Rendering DoclingDocument…' })

      void fetch('/docling-render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: doclingDocument }),
        cache: 'no-store',
        signal: controller.signal
      })
        .then(async (response) => {
          const payload = (await response.json()) as {
            document?: DoclingDocument
            error?: string
          }

          if (!response.ok || !payload.document) {
            throw new Error(payload.error ?? `Docling render failed (${response.status}).`)
          }

          setRenderState({ status: 'ready', document: payload.document })
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return
          }

          setRenderState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Docling render failed.'
          })
        })
    }, RENDER_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [doclingDocument])

  useEffect(() => {
    if (renderState.status !== 'ready' || !viewerHost.current) {
      return
    }

    let disposed = false

    void ensureDoclingComponents()
      .then(() => {
        if (disposed || !viewerHost.current || renderState.status !== 'ready') {
          return
        }

        const viewer = document.createElement('docling-img') as DoclingImgElement
        viewer.setAttribute('pagenumbers', '')
        viewer.appendChild(document.createElement('docling-tooltip'))
        viewer.src = renderState.document
        viewerHost.current.replaceChildren(viewer)
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRenderState({
            status: 'error',
            message: error instanceof Error ? error.message : 'Unable to load Docling renderer component.'
          })
        }
      })

    return () => {
      disposed = true
    }
  }, [renderState])

  return (
    <div className={styles.root}>
      {renderState.status === 'ready' ? (
        <div ref={viewerHost} className={styles.viewer} />
      ) : (
        <div className={styles.status}>{renderState.message}</div>
      )}
    </div>
  )
}
