'use client'

import { RendererIframe } from '../common/renderer-iframe/renderer-iframe'
import { EditorToRendererCommunicatorContextProvider } from '../editor-page/render-context/editor-to-renderer-communicator-context-provider'
import { CommunicatorImageLightbox } from '../markdown-renderer/extensions/image/communicator-image-lightbox'
import { ExtensionEventEmitterProvider } from '../markdown-renderer/hooks/use-extension-event-emitter'
import { RendererType } from '../render-page/window-post-message-communicator/rendering-message'
import React, { useMemo } from 'react'

interface MemexReadOnlyMarkdownProps {
  content: string
}

export const MemexReadOnlyMarkdown: React.FC<MemexReadOnlyMarkdownProps> = ({
  content,
}) => {
  const markdownContentLines = useMemo(() => content.split('\n'), [content])

  return (
    <EditorToRendererCommunicatorContextProvider>
      <ExtensionEventEmitterProvider>
        <CommunicatorImageLightbox />
        <RendererIframe
          frameClasses='w-100 vh-100'
          markdownContentLines={markdownContentLines}
          rendererType={RendererType.DOCUMENT}
          showWaitSpinner={true}
        />
      </ExtensionEventEmitterProvider>
    </EditorToRendererCommunicatorContextProvider>
  )
}
