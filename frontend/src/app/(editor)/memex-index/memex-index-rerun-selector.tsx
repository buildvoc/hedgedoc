'use client'

import { useEffect } from 'react'

const BATCH_SIZE = 4
const PROCESS_POLL_MS = 3000
const PROCESS_TIMEOUT_MS = 45 * 60 * 1000
const ENHANCED_ATTR = 'data-memex-rerun-enhanced'

type QueueStatusResponse = {
  pending?: string[]
  error?: string
}

type QueueResult = {
  queued?: string[]
  skipped?: Array<{ alias: string; reason: string }>
  pending?: string[]
  error?: string
}

type ProcessStatusResponse = {
  running?: boolean
  error?: string
}

type TrailCatalogueResponse = {
  trails?: Array<{
    members?: Array<{ alias?: string }>
  }>
  error?: string
}

const sourceAliasFromAnchor = (anchor: HTMLAnchorElement): string | undefined => {
  try {
    const url = new URL(anchor.href, window.location.origin)
    const match = url.pathname.match(/^\/(?:n|p|s)\/([^/?#]+)\/?$/)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

const setButtonStyle = (button: HTMLButtonElement): void => {
  button.type = 'button'
  button.style.padding = '0.35rem 0.65rem'
  button.style.border = '1px solid var(--bs-border-color, #ced4da)'
  button.style.borderRadius = '0.35rem'
  button.style.background = 'var(--bs-body-bg, #fff)'
  button.style.color = 'var(--bs-body-color, #212529)'
  button.style.cursor = 'pointer'
}

const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds))

export const MemexIndexRerunSelector = () => {
  useEffect(() => {
    let observer: MutationObserver | undefined
    let stopped = false

    const install = async () => {
      if (stopped) return

      const sourceDetails = Array.from(document.querySelectorAll('details')).find((details) => {
        const summary = details.querySelector(':scope > summary')
        return /^Sources\s*\(\d+\)/i.test(summary?.textContent?.trim() ?? '')
      })

      if (!sourceDetails || sourceDetails.hasAttribute(ENHANCED_ATTR)) {
        return
      }

      const sourceEntries: Array<{
        alias: string
        anchor: HTMLAnchorElement
        checkbox: HTMLInputElement
      }> = []
      const seen = new Set<string>()

      for (const anchor of Array.from(sourceDetails.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
        const alias = sourceAliasFromAnchor(anchor)
        if (!alias || seen.has(alias)) continue

        seen.add(alias)

        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.setAttribute('aria-label', `Select ${anchor.textContent?.trim() || alias} for Memex rerun`)
        checkbox.dataset.memexAlias = alias
        checkbox.style.width = '1.05rem'
        checkbox.style.height = '1.05rem'
        checkbox.style.margin = '0'
        checkbox.style.cursor = 'pointer'
        checkbox.style.pointerEvents = 'auto'

        const checkboxWrap = document.createElement('span')
        checkboxWrap.style.display = 'inline-flex'
        checkboxWrap.style.alignItems = 'center'
        checkboxWrap.style.marginRight = '0.55rem'
        checkboxWrap.style.verticalAlign = 'middle'
        checkboxWrap.style.position = 'relative'
        checkboxWrap.style.zIndex = '3'
        checkboxWrap.style.pointerEvents = 'auto'
        checkboxWrap.addEventListener('click', (event) => event.stopPropagation())
        checkboxWrap.addEventListener('mousedown', (event) => event.stopPropagation())
        checkboxWrap.appendChild(checkbox)

        anchor.parentNode?.insertBefore(checkboxWrap, anchor)

        sourceEntries.push({ alias, anchor, checkbox })
      }

      if (sourceEntries.length < 1) {
        return
      }

      sourceDetails.setAttribute(ENHANCED_ATTR, 'true')

      const toolbar = document.createElement('div')
      toolbar.style.display = 'flex'
      toolbar.style.flexWrap = 'wrap'
      toolbar.style.alignItems = 'center'
      toolbar.style.gap = '0.5rem'
      toolbar.style.padding = '0.7rem'
      toolbar.style.margin = '0 0 0.75rem 0'
      toolbar.style.border = '1px solid var(--bs-border-color, #dee2e6)'
      toolbar.style.borderRadius = '0.4rem'
      toolbar.style.background = 'var(--bs-tertiary-bg, #f8f9fa)'

      const status = document.createElement('span')
      status.style.flexBasis = '100%'
      status.style.fontSize = '0.9rem'
      status.style.marginTop = '0.15rem'

      const selected = new Set<string>()
      const pending = new Set<string>()
      let processing = false
      let resetButton: HTMLButtonElement | undefined
      let selectAllButton: HTMLButtonElement | undefined
      let clearButton: HTMLButtonElement | undefined

      const queueButton = document.createElement('button')
      setButtonStyle(queueButton)

      const replacePending = (aliases: string[]) => {
        pending.clear()
        for (const alias of aliases) {
          if (alias) pending.add(alias)
        }
      }

      const updateUi = () => {
        for (const entry of sourceEntries) {
          entry.checkbox.checked = selected.has(entry.alias)
          entry.checkbox.disabled = processing || pending.has(entry.alias)

          if (processing) {
            entry.checkbox.title = 'Automatic Memex rerun processing is active'
          } else if (pending.has(entry.alias)) {
            entry.checkbox.title = 'Already pending in Memex queue'
          } else {
            entry.checkbox.title = 'Select this source for rerun'
          }
        }

        queueButton.textContent = processing
          ? `Processing selected (${selected.size} remaining)`
          : `Queue + process selected (${selected.size})`
        queueButton.disabled = processing || selected.size === 0
        queueButton.style.opacity = queueButton.disabled ? '0.55' : '1'

        if (selectAllButton) {
          selectAllButton.disabled = processing
          selectAllButton.style.opacity = processing ? '0.55' : '1'
        }
        if (clearButton) {
          clearButton.disabled = processing
          clearButton.style.opacity = processing ? '0.55' : '1'
        }
        if (resetButton) {
          resetButton.disabled = processing
          resetButton.style.opacity = processing ? '0.55' : '1'
        }
      }

      const clearSelection = () => {
        selected.clear()
        updateUi()
      }

      const fetchPending = async (): Promise<string[]> => {
        const response = await fetch('/memex-rerun-batch', {
          method: 'GET',
          cache: 'no-store'
        })
        const data = (await response.json()) as QueueStatusResponse

        if (!response.ok) {
          throw new Error(data.error || `Unable to read pending queue: HTTP ${response.status}`)
        }

        return Array.isArray(data.pending) ? data.pending : []
      }

      const refreshPending = async (): Promise<void> => {
        replacePending(await fetchPending())
        updateUi()
      }

      const queueBatch = async (aliases: string[]): Promise<QueueResult> => {
        const response = await fetch('/memex-rerun-batch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ aliases })
        })
        const result = (await response.json()) as QueueResult

        if (!response.ok) {
          throw new Error(result.error || `Unable to queue rerun batch: HTTP ${response.status}`)
        }

        if (Array.isArray(result.pending)) {
          replacePending(result.pending)
        } else {
          await refreshPending()
        }

        updateUi()
        return result
      }

      const fetchTrailMemberAliases = async (): Promise<Set<string>> => {
        const response = await fetch('/memex-trails', {
          method: 'GET',
          cache: 'no-store'
        })
        const result = (await response.json()) as TrailCatalogueResponse

        if (!response.ok) {
          throw new Error(result.error || `Unable to read Memex trails: HTTP ${response.status}`)
        }

        const aliases = new Set<string>()
        for (const trail of result.trails ?? []) {
          for (const member of trail.members ?? []) {
            if (typeof member.alias === 'string' && member.alias) {
              aliases.add(member.alias)
            }
          }
        }
        return aliases
      }

      const fetchProcessRunning = async (): Promise<boolean> => {
        const response = await fetch('/memex-process', {
          method: 'GET',
          cache: 'no-store'
        })
        const result = (await response.json()) as ProcessStatusResponse

        if (!response.ok) {
          throw new Error(result.error || `Unable to read process state: HTTP ${response.status}`)
        }

        return result.running === true
      }

      const requestProcessPending = async (aliases: string[]): Promise<void> => {
        const response = await fetch('/memex-process', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ aliases })
        })
        const detail = (await response.text()).trim()

        if (!response.ok) {
          throw new Error(
            `Scoped Process Pending failed: HTTP ${response.status}` +
              (detail ? ` ${detail.slice(0, 300)}` : '')
          )
        }
      }

      const waitForBatch = async (batchAliases: string[], label: string): Promise<void> => {
        const deadline = Date.now() + PROCESS_TIMEOUT_MS

        while (!stopped) {
          await refreshPending()
          const stillPending = batchAliases.filter((alias) => pending.has(alias))

          if (stillPending.length === 0) {
            return
          }

          const running = await fetchProcessRunning()
          if (!running) {
            throw new Error(
              `${label} runner stopped with ${stillPending.length} source(s) still pending. ` +
              'No later selected batch was queued; inspect /tmp/memex-process-queue.log and retry the failed source(s).'
            )
          }

          if (Date.now() >= deadline) {
            throw new Error(
              `${label} did not finish within 45 minutes; ${stillPending.length} source(s) are still pending.`
            )
          }

          status.textContent =
            `${label}: ${stillPending.length} of this scoped batch still pending. ` +
            `${pending.size} source(s) are pending globally; unrelated pending sources are not processed by this run.`
          await sleep(PROCESS_POLL_MS)
        }
      }

      sourceEntries.forEach((entry) => {
        entry.checkbox.addEventListener('click', (event) => event.stopPropagation())
        entry.checkbox.addEventListener('change', () => {
          if (entry.checkbox.checked && !pending.has(entry.alias)) {
            selected.add(entry.alias)
          } else {
            selected.delete(entry.alias)
          }
          updateUi()
        })
      })

      const label = document.createElement('strong')
      label.textContent = `${sourceEntries.length} sources · select any number · automatic processing ${BATCH_SIZE} at a time`
      label.style.marginRight = '0.25rem'
      toolbar.appendChild(label)

      selectAllButton = document.createElement('button')
      setButtonStyle(selectAllButton)
      selectAllButton.textContent = 'Select all available'
      selectAllButton.addEventListener('click', () => {
        for (const entry of sourceEntries) {
          if (!pending.has(entry.alias)) selected.add(entry.alias)
        }
        status.textContent = `${selected.size} source(s) selected.`
        updateUi()
      })
      toolbar.appendChild(selectAllButton)

      clearButton = document.createElement('button')
      setButtonStyle(clearButton)
      clearButton.textContent = 'Clear'
      clearButton.addEventListener('click', clearSelection)
      toolbar.appendChild(clearButton)

      queueButton.style.fontWeight = '600'
      queueButton.addEventListener('click', async () => {
        if (selected.size < 1 || processing) return

        const requestedAliases = Array.from(selected)
        const totalRequested = requestedAliases.length
        let completed = 0
        let batchNumber = 0
        let verifiedTrailMembers = 0

        processing = true
        updateUi()

        try {
          await refreshPending()

          const alreadyPendingSelected = requestedAliases.filter((alias) => pending.has(alias))
          if (alreadyPendingSelected.length > 0) {
            throw new Error(
              `${alreadyPendingSelected.length} selected source(s) became pending before the run started. ` +
              'Refresh /memex-index and select only non-pending sources.'
            )
          }

          const remaining = [...requestedAliases]
          const allowedTrailAliases = await fetchTrailMemberAliases()

          while (remaining.length > 0) {
            const chunk = remaining.splice(0, BATCH_SIZE)
            batchNumber += 1

            status.textContent =
              `Batch ${batchNumber}: queueing ${chunk.length} source(s) ` +
              `(${completed}/${totalRequested} completed)...`

            const result = await queueBatch(chunk)
            const queued = result.queued ?? []
            const skipped = result.skipped ?? []

            if (queued.length !== chunk.length) {
              const detail = skipped
                .map((item) => `${item.alias}: ${item.reason}`)
                .join('; ')
              throw new Error(
                `Batch ${batchNumber} queued ${queued.length}/${chunk.length} source(s).` +
                  (detail ? ` ${detail}` : '')
              )
            }

            status.textContent =
              `Batch ${batchNumber}: scoped processing ${queued.length} source(s). ` +
              `${pending.size} source(s) are pending globally; only this batch is eligible for this runner.`

            await requestProcessPending(queued)
            await waitForBatch(queued, `Batch ${batchNumber}`)

            for (const alias of chunk) {
              allowedTrailAliases.add(alias)
            }

            const currentTrailAliases = await fetchTrailMemberAliases()
            const leakedTrailAliases = Array.from(currentTrailAliases).filter(
              (alias) => !allowedTrailAliases.has(alias)
            )

            if (leakedTrailAliases.length > 0) {
              throw new Error(
                `Batch ${batchNumber} trail-scope verification failed: ` +
                  `${leakedTrailAliases.length} unselected source(s) appeared in trails ` +
                  `(${leakedTrailAliases.slice(0, 4).join(', ')}${
                    leakedTrailAliases.length > 4 ? ', ...' : ''
                  }). No later selected batch was queued.`
              )
            }

            verifiedTrailMembers = currentTrailAliases.size

            for (const alias of chunk) {
              selected.delete(alias)
            }
            completed += chunk.length
            updateUi()
          }

          await refreshPending()
          status.textContent =
            `Completed ${completed} selected source(s) in ${batchNumber} automatic batch(es), maximum ${BATCH_SIZE} at a time. ` +
            `Trail scope verified (${verifiedTrailMembers} current trail member source(s)). ` +
            'Association recommendations, if generated, are ready for human review.'
        } catch (error) {
          status.textContent =
            `Automatic rerun stopped: ${error instanceof Error ? error.message : String(error)} ` +
            'Completed batches stay processed; unprocessed selections remain checked.'
        } finally {
          processing = false
          try {
            await refreshPending()
          } catch {
            updateUi()
          }
        }
      })
      toolbar.appendChild(queueButton)

      const pendingLink = document.createElement('a')
      pendingLink.href = '/explore/my?memex=pending'
      pendingLink.textContent = 'Open Process Pending'
      pendingLink.style.marginLeft = '0.25rem'
      toolbar.appendChild(pendingLink)

      resetButton = document.createElement('button')
      setButtonStyle(resetButton)
      resetButton.textContent = 'Snapshot + reset all trails'
      resetButton.style.fontWeight = '600'
      resetButton.style.marginLeft = '0.25rem'
      resetButton.addEventListener('click', async () => {
        const confirmation = window.prompt(
          'This will snapshot current Memex/nodeBook generated data, then clear all trail memberships while preserving sources, queue history, and canonical associations. Type RESET to continue.'
        )

        if (confirmation !== 'RESET') {
          status.textContent = 'Trail reset cancelled.'
          return
        }

        resetButton!.disabled = true
        status.textContent = 'Creating snapshot before resetting trail state...'

        try {
          const response = await fetch('/memex-reset-trails', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              confirm: 'RESET'
            })
          })

          const result = (await response.json()) as {
            snapshot?: string
            error?: string
          }

          if (!response.ok) {
            throw new Error(result.error || `HTTP ${response.status}`)
          }

          clearSelection()
          pending.clear()
          status.textContent =
            `Snapshot created at ${result.snapshot ?? 'unknown path'}. ` +
            'Trail state reset. Reloading Memex Index...'

          window.setTimeout(() => {
            window.location.reload()
          }, 1200)
        } catch (error) {
          status.textContent =
            `Snapshot/reset failed: ${error instanceof Error ? error.message : String(error)}`
          resetButton!.disabled = false
        }
      })
      toolbar.appendChild(resetButton)

      toolbar.appendChild(status)
      sourceDetails.parentNode?.insertBefore(toolbar, sourceDetails)

      try {
        await refreshPending()
        status.textContent =
          pending.size > 0
            ? `${pending.size} catalogue source(s) are already pending. They remain untouched by scoped reruns; select any other sources and automatic processing will run only ${BATCH_SIZE} selected sources at a time.`
            : `Select any number of sources. Queue + process selected will process them automatically in scoped batches of up to ${BATCH_SIZE}.`
      } catch (error) {
        status.textContent =
          `Pending status unavailable: ${error instanceof Error ? error.message : String(error)}. ` +
          'Selection remains available, but automatic processing should not be started until queue status is readable.'
      }

      updateUi()
    }

    void install()

    observer = new MutationObserver(() => {
      void install()
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true
    })

    return () => {
      stopped = true
      observer?.disconnect()
    }
  }, [])

  return null
}
