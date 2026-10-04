/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useApplicationState } from '../../../../hooks/common/use-application-state'
import { cypressId } from '../../../../utils/cypress-attribute'
import { FileContentFormat, readFile } from '../../../../utils/read-file'
import { UploadInput } from '../../../common/upload-input'
import { useChangeEditorContentCallback } from '../../change-content-context/use-change-editor-content-callback'
import { SidebarButton } from '../sidebar-button/sidebar-button'
import { externalizeDoclingMedia } from './docling-media-import'
import React, { Fragment, useCallback, useRef, useState } from 'react'
import { FileEarmarkCode as IconFileEarmarkCode } from 'react-bootstrap-icons'

type DoclingDocument = {
  schema_name?: unknown
  [key: string]: unknown
}

const parseDoclingDocument = (rawContent: string): DoclingDocument => {
  const parsed: unknown = JSON.parse(rawContent)

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a DoclingDocument JSON object.')
  }

  const document = parsed as DoclingDocument

  if (document.schema_name !== 'DoclingDocument') {
    throw new Error('JSON is not a DoclingDocument (schema_name must be "DoclingDocument").')
  }

  return document
}

const showImportError = (error: unknown): void => {
  const message = error instanceof Error ? error.message : 'Unknown import error'
  console.error('Docling import failed', error)
  window.alert(`Docling import failed: ${message}`)
}

/**
 * Imports a serialized DoclingDocument into the current HedgeDoc note.
 *
 * Embedded image data URIs are first uploaded through HedgeDoc native media,
 * then only their JSON uri values are rewritten to media/<uuid>.
 */
export const ImportDoclingSidebarEntry: React.FC = () => {
  const changeEditorContent = useChangeEditorContentCallback()
  const noteAlias = useApplicationState((state) => state.noteDetails?.primaryAlias)
  const [loading, setLoading] = useState(false)

  const onImportDocling = useCallback(
    async (file: File): Promise<void> => {
      if (!changeEditorContent || !noteAlias) {
        return
      }

      setLoading(true)

      try {
        const rawContent = await readFile(file, FileContentFormat.TEXT)
        const document = parseDoclingDocument(rawContent)
        const result = await externalizeDoclingMedia(document, noteAlias)
        const json = JSON.stringify(result.document)

        changeEditorContent(({ markdownContent }) => {
          const newContent = (markdownContent.length === 0 ? '' : '\n') + json
          return [[{ from: markdownContent.length, to: markdownContent.length, insert: newContent }], undefined]
        })
      } catch (error) {
        showImportError(error)
      } finally {
        setLoading(false)
      }
    },
    [changeEditorContent, noteAlias]
  )

  const clickRef = useRef<() => void>()
  const buttonClick = useCallback(() => {
    clickRef.current?.()
  }, [])

  return (
    <Fragment>
      <SidebarButton
        {...cypressId('menu-import-docling-button')}
        icon={IconFileEarmarkCode}
        onClick={buttonClick}
        disabled={!changeEditorContent || !noteAlias || loading}>
        {loading ? 'Importing Docling…' : 'Docling Document (JSON)'}
      </SidebarButton>
      {changeEditorContent !== undefined && noteAlias !== undefined && (
        <UploadInput
          onLoad={onImportDocling}
          {...cypressId('menu-import-docling-input')}
          allowedFileTypes={'.json, application/json'}
          onClickRef={clickRef}
        />
      )}
    </Fragment>
  )
}
