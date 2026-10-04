'use client'
/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type { NoteType } from '@hedgedoc/commons'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Form, Spinner } from 'react-bootstrap'
import { getMyNoteTags } from '../../../../api/explore'
import styles from './filter-by-tags.module.css'

export interface FilterByTagsProps {
  typeFilter: NoteType | null
  value: string[]
  onChange: (value: string[]) => void
}

/**
 * HedgeDoc 1-style stacked tag autocomplete for Explore.
 * Suggestions come from one dedicated distinct-tags Explore API request.
 */
export const FilterByTags: React.FC<FilterByTagsProps> = ({ typeFilter, value, onChange }) => {
  const [input, setInput] = useState('')
  const [availableTags, setAvailableTags] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setAvailableTags([])
    setLoaded(false)
  }, [typeFilter])

  const loadTags = useCallback(async () => {
    if (loaded || loading) return

    setLoading(true)
    try {
      setAvailableTags(await getMyNoteTags(typeFilter))
      setLoaded(true)
    } finally {
      setLoading(false)
    }
  }, [loaded, loading, typeFilter])

  const selectedKeys = useMemo(() => new Set(value.map((tag) => tag.toLocaleLowerCase())), [value])
  const suggestions = useMemo(() => {
    const term = input.trim().toLocaleLowerCase()
    return availableTags
      .filter((tag) => !selectedKeys.has(tag.toLocaleLowerCase()))
      .filter((tag) => term.length === 0 || tag.toLocaleLowerCase().includes(term))
      .slice(0, 100)
  }, [availableTags, input, selectedKeys])

  const addTag = useCallback(
    (tag: string) => {
      if (!selectedKeys.has(tag.toLocaleLowerCase())) onChange([...value, tag])
      setInput('')
      setOpen(true)
    },
    [onChange, selectedKeys, value]
  )

  const removeTag = useCallback(
    (tag: string) => {
      const key = tag.toLocaleLowerCase()
      onChange(value.filter((candidate) => candidate.toLocaleLowerCase() !== key))
    },
    [onChange, value]
  )

  return (
    <div className={styles.wrapper}>
      <div className={styles.control}>
        {value.map((tag) => (
          <button key={tag} type={'button'} className={styles.tag} onClick={() => removeTag(tag)} title={`Remove ${tag}`}>
            {tag} <span aria-hidden={'true'}>×</span>
          </button>
        ))}
        <Form.Control
          className={styles.input}
          value={input}
          size={'sm'}
          type={'search'}
          autoComplete={'off'}
          aria-label={'Filter notes by tags'}
          placeholder={value.length > 0 ? 'Add tag…' : 'Filter by tags…'}
          onFocus={() => {
            setOpen(true)
            void loadTags()
          }}
          onBlur={() => setOpen(false)}
          onChange={(event) => {
            setInput(event.target.value)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && suggestions.length > 0) {
              event.preventDefault()
              addTag(suggestions[0])
            } else if (event.key === 'Backspace' && input.length === 0 && value.length > 0) {
              removeTag(value[value.length - 1])
            }
          }}
        />
        {loading && <Spinner className={styles.spinner} animation={'border'} size={'sm'} />}
      </div>
      {open && loaded && suggestions.length > 0 && (
        <div className={styles.suggestions} role={'listbox'}>
          {suggestions.map((tag) => (
            <button
              key={tag}
              type={'button'}
              className={styles.suggestion}
              role={'option'}
              aria-selected={'false'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addTag(tag)}>
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
