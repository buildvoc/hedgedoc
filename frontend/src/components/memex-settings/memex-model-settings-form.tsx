'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Col, Form, Row, Spinner } from 'react-bootstrap'

type MemexKvCacheType = 'f16' | 'q8_0' | 'q4_0'

interface MemexModelSettings {
  provider: 'ollama'
  baseUrl: string
  defaultModel: string
  numCtx: number
  maxPromptChars: number
  timeoutSeconds: number
  temperature: number
  ollamaFlashAttention: boolean
  ollamaKvCacheType: MemexKvCacheType
}

interface ModelsResponse {
  connected?: boolean
  baseUrl?: string
  defaultModel?: string
  models?: string[]
  error?: string
}

const emptySettings: MemexModelSettings = {
  provider: 'ollama',
  baseUrl: '',
  defaultModel: '',
  numCtx: 65536,
  maxPromptChars: 80000,
  timeoutSeconds: 600,
  temperature: 0.35,
  ollamaFlashAttention: true,
  ollamaKvCacheType: 'q8_0',
}

export const MemexModelSettingsForm: React.FC = () => {
  const [settings, setSettings] = useState<MemexModelSettings>(emptySettings)
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const loadModels = useCallback(async () => {
    const response = await fetch('/memex-models', { cache: 'no-store' })
    const payload = (await response.json()) as ModelsResponse
    setModels(payload.models ?? [])

    if (!response.ok || !payload.connected) {
      throw new Error(payload.error || `Ollama model discovery HTTP ${response.status}`)
    }

    return payload
  }, [])

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      setLoading(true)
      setError('')

      try {
        const response = await fetch('/memex-model-settings', {
          cache: 'no-store',
        })
        const payload = (await response.json()) as MemexModelSettings & {
          error?: string
        }

        if (!response.ok) {
          throw new Error(payload.error || `Settings HTTP ${response.status}`)
        }

        if (!cancelled) setSettings(payload)

        try {
          await loadModels()
        } catch (caught) {
          if (!cancelled) {
            setError(
              caught instanceof Error
                ? caught.message
                : 'Unable to discover Ollama models',
            )
          }
        }
      } catch (caught) {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : 'Unable to load settings',
          )
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()

    return () => {
      cancelled = true
    }
  }, [loadModels])

  const setNumber = (
    key: keyof Pick<
      MemexModelSettings,
      | 'numCtx'
      | 'maxPromptChars'
      | 'timeoutSeconds'
      | 'temperature'
    >,
    value: string,
  ) => {
    setSettings((current) => ({
      ...current,
      [key]: Number(value),
    }))
  }

  const testConnection = async () => {
    setTesting(true)
    setMessage('')
    setError('')

    try {
      const payload = await loadModels()
      setMessage(
        `Connected to ${payload.baseUrl}. ${payload.models?.length ?? 0} model${payload.models?.length === 1 ? '' : 's'} available.`,
      )
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Unable to connect to Ollama',
      )
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    setSaving(true)
    setMessage('')
    setError('')

    try {
      const response = await fetch('/memex-model-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      })
      const payload = (await response.json()) as MemexModelSettings & {
        error?: string
      }

      if (!response.ok) {
        throw new Error(payload.error || `Settings HTTP ${response.status}`)
      }

      setSettings(payload)
      setMessage('Memex model defaults saved.')

      try {
        await loadModels()
      } catch {
        // Settings are valid even when the configured Ollama server is offline.
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to save settings')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className='d-flex align-items-center gap-2'>
        <Spinner animation='border' size='sm' /> Loading Memex model settings…
      </div>
    )
  }

  const modelOptions = Array.from(
    new Set([settings.defaultModel, ...models].filter(Boolean)),
  )

  return (
    <Card>
      <Card.Body>
        {error && <Alert variant='warning'>{error}</Alert>}
        {message && <Alert variant='success'>{message}</Alert>}

        <h2 className='h5'>Ollama server</h2>
        <Row className='g-3 mb-4'>
          <Col md={9}>
            <Form.Group controlId='memex-ollama-base-url'>
              <Form.Label>Base URL</Form.Label>
              <Form.Control
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    baseUrl: event.target.value,
                  }))
                }
                type='url'
                value={settings.baseUrl}
              />
            </Form.Group>
          </Col>
          <Col className='d-flex align-items-end' md={3}>
            <Button
              disabled={testing}
              onClick={() => void testConnection()}
              variant='outline-primary'
            >
              {testing ? 'Testing…' : 'Test / Refresh models'}
            </Button>
          </Col>
        </Row>

        <h2 className='h5'>Model</h2>
        <Row className='g-3 mb-4'>
          <Col md={6}>
            <Form.Group controlId='memex-default-model'>
              <Form.Label>Default model</Form.Label>
              <Form.Select
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    defaultModel: event.target.value,
                  }))
                }
                value={settings.defaultModel}
              >
                {modelOptions.map((model) => (
                  <option key={model} value={model}>
                    {model}
                  </option>
                ))}
              </Form.Select>
              <Form.Text className='text-muted'>
                Used for trail maintenance, summaries and association suggestions.
                Association suggestions are reviewed by a human; no second LLM
                verifier is called by Process Pending.
              </Form.Text>
            </Form.Group>
          </Col>
        </Row>

        <h2 className='h5'>Context and generation</h2>
        <Row className='g-3 mb-4'>
          <Col md={4}>
            <Form.Group controlId='memex-num-ctx'>
              <Form.Label>Context (num_ctx)</Form.Label>
              <Form.Control
                min={1024}
                onChange={(event) => setNumber('numCtx', event.target.value)}
                step={1024}
                type='number'
                value={settings.numCtx}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group controlId='memex-max-prompt-chars'>
              <Form.Label>Max prompt chars</Form.Label>
              <Form.Control
                min={1000}
                onChange={(event) =>
                  setNumber('maxPromptChars', event.target.value)
                }
                step={1000}
                type='number'
                value={settings.maxPromptChars}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group controlId='memex-timeout'>
              <Form.Label>Timeout seconds</Form.Label>
              <Form.Control
                min={10}
                onChange={(event) =>
                  setNumber('timeoutSeconds', event.target.value)
                }
                type='number'
                value={settings.timeoutSeconds}
              />
            </Form.Group>
          </Col>
          <Col md={4}>
            <Form.Group controlId='memex-temperature'>
              <Form.Label>Temperature</Form.Label>
              <Form.Control
                max={2}
                min={0}
                onChange={(event) => setNumber('temperature', event.target.value)}
                step={0.05}
                type='number'
                value={settings.temperature}
              />
            </Form.Group>
          </Col>
        </Row>

        <h2 className='h5'>Ollama runtime profile</h2>
        <Alert variant='info'>
          These values are saved with the Memex model settings as the desired
          configuration for the remote Ollama daemon. They are not request-level
          Ollama options, so saving this page does not restart or reconfigure the
          remote server.
        </Alert>
        <Row className='g-3 mb-3'>
          <Col md={6}>
            <Form.Group controlId='memex-ollama-flash-attention'>
              <Form.Check
                checked={settings.ollamaFlashAttention}
                label='Enable Ollama Flash Attention'
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    ollamaFlashAttention: event.target.checked,
                    ollamaKvCacheType: event.target.checked
                      ? current.ollamaKvCacheType
                      : 'f16',
                  }))
                }
                type='switch'
              />
              <Form.Text className='text-muted'>
                Required by Ollama for quantized KV cache. This is Ollama's
                runtime setting, not the separate upstream FlashAttention-2
                package.
              </Form.Text>
            </Form.Group>
          </Col>
          <Col md={6}>
            <Form.Group controlId='memex-ollama-kv-cache-type'>
              <Form.Label>KV cache type</Form.Label>
              <Form.Select
                disabled={!settings.ollamaFlashAttention}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    ollamaKvCacheType: event.target.value as MemexKvCacheType,
                  }))
                }
                value={settings.ollamaKvCacheType}
              >
                <option value='f16'>f16 — quality reference / most VRAM</option>
                <option value='q8_0'>q8_0 — recommended dual-P100 default</option>
                <option value='q4_0'>q4_0 — maximum KV saving; benchmark first</option>
              </Form.Select>
              <Form.Text className='text-muted'>
                Start with q8_0 on the dual 16 GB P100 host. Use q4_0 only after
                comparing association precision on the same frozen snapshot.
              </Form.Text>
            </Form.Group>
          </Col>
        </Row>

        <div className='mb-4'>
          <Form.Label>Remote Ollama daemon environment</Form.Label>
          <pre className='border rounded p-3 mb-0'>
            <code>{`OLLAMA_FLASH_ATTENTION=${settings.ollamaFlashAttention ? '1' : '0'}\nOLLAMA_KV_CACHE_TYPE=${settings.ollamaKvCacheType}`}</code>
          </pre>
          <Form.Text className='text-muted'>
            Apply these environment values on the Ollama host and restart
            ollama.service separately. The Memex server currently connects to the
            configured Base URL above.
          </Form.Text>
        </div>

        <div className='d-flex justify-content-end'>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save Memex defaults'}
          </Button>
        </div>
      </Card.Body>
    </Card>
  )
}
