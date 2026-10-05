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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const collectMediaUris = (value: unknown, uris: Set<string>): void => {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectMediaUris(entry, uris))
    return
  }

  if (!isRecord(value)) {
    return
  }

  Object.entries(value).forEach(([key, entry]) => {
    if (key === 'uri' && typeof entry === 'string' && /^\/?media\//.test(entry)) {
      uris.add(entry)
    } else {
      collectMediaUris(entry, uris)
    }
  })
}

const replaceMediaUris = (value: unknown, replacements: Map<string, string>): void => {
  if (Array.isArray(value)) {
    value.forEach((entry) => replaceMediaUris(entry, replacements))
    return
  }

  if (!isRecord(value)) {
    return
  }

  Object.entries(value).forEach(([key, entry]) => {
    if (key === 'uri' && typeof entry === 'string') {
      const replacement = replacements.get(entry)
      if (replacement) {
        value[key] = replacement
      }
    } else {
      replaceMediaUris(entry, replacements)
    }
  })
}

const blobToDataUri = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
      } else {
        reject(new Error('Unable to encode HedgeDoc media image.'))
      }
    })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Unable to read HedgeDoc media image.')))
    reader.readAsDataURL(blob)
  })

const rehydrateMediaUris = async (document: DoclingDocument, signal: AbortSignal): Promise<DoclingDocument> => {
  const prepared = structuredClone(document)
  const mediaUris = new Set<string>()
  collectMediaUris(prepared, mediaUris)

  const mediaReplacements = new Map(
    await Promise.all(
      Array.from(mediaUris).map(async (uri) => {
        const mediaUrl = uri.startsWith('/') ? uri : `/${uri}`
        const response = await fetch(mediaUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal
        })

        if (!response.ok) {
          throw new Error(`Unable to load HedgeDoc media ${uri} (${response.status}).`)
        }

        return [uri, await blobToDataUri(await response.blob())] as const
      })
    )
  )

  replaceMediaUris(prepared, mediaReplacements)
  return prepared
}

const normalizePageImageDisplaySizes = (document: DoclingDocument): DoclingDocument => {
  const normalized = structuredClone(document)
  const pages = normalized.pages
  if (!isRecord(pages)) {
    return normalized
  }

  Object.values(pages).forEach((page) => {
    if (!isRecord(page) || !isRecord(page.size) || !isRecord(page.image) || !isRecord(page.image.size)) {
      return
    }

    const width = page.size.width
    const height = page.size.height
    if (typeof width !== 'number' || typeof height !== 'number') {
      return
    }

    // docling-img uses image.size.width as the rendered SVG width but page.size
    // as its viewBox. Page images generated at 144 DPI are roughly 2 pixels
    // per 72-DPI document point, so use the logical page dimensions for display
    // while keeping the high-resolution embedded bitmap unchanged.
    page.image.size = { ...page.image.size, width, height }
  })

  return normalized
}

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
 * The note remains compact JSON in the editor; HedgeDoc media is expanded only in memory for rendering.
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

      // Stored Docling JSON stays compact with media/<uuid> references.
      // Rehydrate those references only in memory before the existing Docling
      // Serve render request; otherwise Docling Serve treats them as local paths.
      void rehydrateMediaUris(doclingDocument, controller.signal)
        .then((preparedDocument) =>
          fetch('/docling-render', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ document: preparedDocument }),
            cache: 'no-store',
            signal: controller.signal
          })
        )
        .then(async (response) => {
          const payload = (await response.json()) as {
            document?: DoclingDocument
            error?: string
          }

          if (!response.ok || !payload.document) {
            throw new Error(payload.error ?? `Docling render failed (${response.status}).`)
          }

          setRenderState({ status: 'ready', document: normalizePageImageDisplaySizes(payload.document) })
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
