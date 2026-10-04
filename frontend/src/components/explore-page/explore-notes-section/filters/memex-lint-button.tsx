'use client'

import React, { useCallback, useState } from 'react'
import { Badge, Button, Spinner } from 'react-bootstrap'

interface LintResult {
  status: string
  orphanPages: number
}

export const MemexLintButton: React.FC = () => {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<LintResult | null>(null)

  const runLint = useCallback(async () => {
    setRunning(true)
    try {
      const response = await fetch('/memex-lint', {
        method: 'POST',
        cache: 'no-store'
      })
      setResult((await response.json()) as LintResult)
    } finally {
      setRunning(false)
    }
  }, [])

  return (
    <div className='d-flex align-items-center gap-2'>
      <Button size='sm' variant='outline-secondary' disabled={running} onClick={runLint}>
        {running && <Spinner animation='border' size='sm' className='me-1' />}
        {running ? 'Linting…' : 'Lint'}
      </Button>

      {result && (
        <>
          <Badge bg={result.status === 'PASS' ? 'success' : 'danger'}>{result.status}</Badge>
          <span className='small'>Orphans: {result.orphanPages}</span>
        </>
      )}
    </div>
  )
}
