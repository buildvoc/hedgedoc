/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { deleteUploadedMedia, uploadFile } from '../../../../api/media'

const DATA_IMAGE_URI = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/

type JsonObject = Record<string, unknown>

type EmbeddedImageReference = {
  target: JsonObject
  originalUri: string
  mimeType: string
  bytes: Uint8Array
  digest: string
}

export type DoclingMediaExternalizationResult = {
  document: JsonObject
  embeddedReferences: number
  uniqueUploads: number
}

const extensionForMimeType = (mimeType: string): string => {
  const extensions: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/tiff': '.tif',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg'
  }

  return extensions[mimeType] ?? '.bin'
}

const decodeBase64 = (payload: string): Uint8Array => {
  const normalized = payload.replace(/\s+/g, '')

  if (normalized.length === 0) {
    throw new Error('Embedded Docling image contains an empty base64 payload.')
  }

  let decoded: string
  try {
    decoded = atob(normalized)
  } catch {
    throw new Error('Embedded Docling image contains invalid base64 data.')
  }

  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

const rightRotate = (value: number, amount: number): number =>
  (value >>> amount) | (value << (32 - amount))

/**
 * Browser-safe SHA-256.
 *
 * The deployment is served over plain LAN HTTP, where SubtleCrypto is not
 * guaranteed to be available, so deduplication must not depend on it.
 */
const sha256Hex = (bytes: Uint8Array): string => {
  const constants = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ])

  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19
  ])

  const bitLength = bytes.length * 8
  const paddingLength = (64 - ((bytes.length + 1 + 8) % 64)) % 64
  const message = new Uint8Array(bytes.length + 1 + paddingLength + 8)
  message.set(bytes)
  message[bytes.length] = 0x80

  const view = new DataView(message.buffer)
  view.setUint32(message.length - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(message.length - 4, bitLength >>> 0, false)

  const words = new Uint32Array(64)

  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }

    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]
      const y = words[index - 2]
      const sigma0 = rightRotate(x, 7) ^ rightRotate(x, 18) ^ (x >>> 3)
      const sigma1 = rightRotate(y, 17) ^ rightRotate(y, 19) ^ (y >>> 10)
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0
    }

    let a = hash[0]
    let b = hash[1]
    let c = hash[2]
    let d = hash[3]
    let e = hash[4]
    let f = hash[5]
    let g = hash[6]
    let h = hash[7]

    for (let index = 0; index < 64; index += 1) {
      const sum1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)
      const choose = (e & f) ^ (~e & g)
      const temp1 = (h + sum1 + choose + constants[index] + words[index]) >>> 0
      const sum0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)
      const majority = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (sum0 + majority) >>> 0

      h = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    hash[0] = (hash[0] + a) >>> 0
    hash[1] = (hash[1] + b) >>> 0
    hash[2] = (hash[2] + c) >>> 0
    hash[3] = (hash[3] + d) >>> 0
    hash[4] = (hash[4] + e) >>> 0
    hash[5] = (hash[5] + f) >>> 0
    hash[6] = (hash[6] + g) >>> 0
    hash[7] = (hash[7] + h) >>> 0
  }

  return Array.from(hash)
    .map((value) => value.toString(16).padStart(8, '0'))
    .join('')
}

const collectEmbeddedImages = (value: unknown, references: EmbeddedImageReference[]): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => collectEmbeddedImages(item, references))
    return
  }

  if (value === null || typeof value !== 'object') {
    return
  }

  const object = value as JsonObject

  for (const [key, item] of Object.entries(object)) {
    if (key === 'uri' && typeof item === 'string') {
      const match = DATA_IMAGE_URI.exec(item)
      if (match) {
        const mimeType = match[1]
        const bytes = decodeBase64(match[2])
        references.push({
          target: object,
          originalUri: item,
          mimeType,
          bytes,
          digest: sha256Hex(bytes)
        })
        continue
      }
    }

    collectEmbeddedImages(item, references)
  }
}

const countEmbeddedImages = (value: unknown): number => {
  let count = 0

  const walk = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(walk)
      return
    }

    if (current === null || typeof current !== 'object') {
      return
    }

    for (const [key, item] of Object.entries(current as JsonObject)) {
      if (key === 'uri' && typeof item === 'string' && DATA_IMAGE_URI.test(item)) {
        count += 1
      } else {
        walk(item)
      }
    }
  }

  walk(value)
  return count
}

const cleanupUploads = async (uuids: string[]): Promise<void> => {
  await Promise.allSettled(uuids.map((uuid) => deleteUploadedMedia(uuid)))
}

export const externalizeDoclingMedia = async (
  document: unknown,
  noteAlias: string
): Promise<DoclingMediaExternalizationResult> => {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Expected a DoclingDocument JSON object.')
  }

  const doclingDocument = document as JsonObject

  if (doclingDocument.schema_name !== 'DoclingDocument') {
    throw new Error('JSON is not a DoclingDocument (schema_name must be "DoclingDocument").')
  }

  if (!noteAlias) {
    throw new Error('Current HedgeDoc note alias is unavailable.')
  }

  const references: EmbeddedImageReference[] = []
  collectEmbeddedImages(doclingDocument, references)

  if (references.length === 0) {
    return {
      document: doclingDocument,
      embeddedReferences: 0,
      uniqueUploads: 0
    }
  }

  const uniqueByDigest = new Map<string, EmbeddedImageReference>()
  for (const reference of references) {
    if (!uniqueByDigest.has(reference.digest)) {
      uniqueByDigest.set(reference.digest, reference)
    }
  }

  const mediaByDigest = new Map<string, string>()
  const uploadedUuids: string[] = []

  try {
    for (const [digest, reference] of uniqueByDigest) {
      const imageBuffer = new ArrayBuffer(reference.bytes.byteLength)
      new Uint8Array(imageBuffer).set(reference.bytes)

      const file = new File(
        [imageBuffer],
        `docling-${digest.slice(0, 16)}${extensionForMimeType(reference.mimeType)}`,
        { type: reference.mimeType }
      )

      const uuid = await uploadFile(noteAlias, file)
      uploadedUuids.push(uuid)
      mediaByDigest.set(digest, `media/${uuid}`)
    }

    for (const reference of references) {
      const replacement = mediaByDigest.get(reference.digest)

      if (!replacement) {
        throw new Error('Docling media rewrite failed after upload.')
      }

      if (reference.target.uri !== reference.originalUri) {
        throw new Error('Docling document changed while media was being uploaded.')
      }

      reference.target.uri = replacement
    }

    if (countEmbeddedImages(doclingDocument) !== 0) {
      throw new Error('Embedded Docling image URIs remain after media externalization.')
    }
  } catch (error) {
    await cleanupUploads(uploadedUuids)
    throw error
  }

  return {
    document: doclingDocument,
    embeddedReferences: references.length,
    uniqueUploads: uniqueByDigest.size
  }
}
