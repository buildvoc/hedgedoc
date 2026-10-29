/*
 * SPDX-FileCopyrightText: 2026 SpecDoc contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { useChangeEditorContentCallback } from '../../../change-content-context/use-change-editor-content-callback'
import React, { useCallback } from 'react'
import { Button } from 'react-bootstrap'
import { ArrowLeftRight, ChatDots, Dash, Eraser, Plus } from 'react-bootstrap-icons'

const clean = (text: string): string => text.replaceAll('<<}', '<< }').replaceAll('{>>', '{ >>')

export const CriticMarkupButtons: React.FC = () => {
  const change = useChangeEditorContentCallback()
  const comment = useCallback(() => change?.(({ currentSelection }) => {
    const value = window.prompt('Review comment (use @name: text for attribution):', '')
    if (!value?.trim()) return [[], currentSelection]
    const marker = `{>>${clean(value.trim())}<<}`
    const at = currentSelection.to ?? currentSelection.from
    return [[{ from: at, to: at, insert: marker }], { from: at + marker.length, to: at + marker.length }]
  }), [change])
  const insertion = useCallback(() => change?.(({ currentSelection, markdownContent }) => {
    const from=currentSelection.from, to=currentSelection.to ?? from
    const value=markdownContent.slice(from,to) || window.prompt('Suggested insertion:', '') || ''
    if (!value) return [[], currentSelection]
    const marker=`{++${value}++}`
    return [[{from,to,insert:marker}],{from:from+marker.length,to:from+marker.length}]
  }), [change])
  const deletion = useCallback(() => change?.(({ currentSelection, markdownContent }) => {
    const from=currentSelection.from, to=currentSelection.to ?? from
    if (to<=from) { window.alert('Select text to mark for deletion.'); return [[], currentSelection] }
    const marker=`{--${markdownContent.slice(from,to)}--}`
    return [[{from,to,insert:marker}],{from:from+marker.length,to:from+marker.length}]
  }), [change])
  const replacement = useCallback(() => change?.(({ currentSelection, markdownContent }) => {
    const from=currentSelection.from, to=currentSelection.to ?? from
    if (to<=from) { window.alert('Select the text to replace first.'); return [[], currentSelection] }
    const oldText=markdownContent.slice(from,to); const newText=window.prompt('Replacement text:', oldText)
    if (newText===null || newText===oldText) return [[], currentSelection]
    const marker=`{~~${oldText}~>${newText}~~}`
    return [[{from,to,insert:marker}],{from:from+marker.length,to:from+marker.length}]
  }), [change])
  const highlight = useCallback(() => change?.(({ currentSelection, markdownContent }) => {
    const from=currentSelection.from, to=currentSelection.to ?? from
    if (to<=from) { window.alert('Select text to highlight.'); return [[], currentSelection] }
    const marker=`{==${markdownContent.slice(from,to)}==}`
    return [[{from,to,insert:marker}],{from:from+marker.length,to:from+marker.length}]
  }), [change])
  const disabled=!change
  return <>
    <Button variant='outline-secondary' className='text-body-emphasis' title='CriticMarkup comment' onClick={comment} disabled={disabled}><ChatDots /></Button>
    <Button variant='outline-secondary' className='text-body-emphasis' title='Suggest insertion' onClick={insertion} disabled={disabled}><Plus /></Button>
    <Button variant='outline-secondary' className='text-body-emphasis' title='Suggest deletion' onClick={deletion} disabled={disabled}><Dash /></Button>
    <Button variant='outline-secondary' className='text-body-emphasis' title='Suggest replacement' onClick={replacement} disabled={disabled}><ArrowLeftRight /></Button>
    <Button variant='outline-secondary' className='text-body-emphasis' title='CriticMarkup highlight' onClick={highlight} disabled={disabled}><Eraser /></Button>
  </>
}
