// @ts-nocheck
// Cloudflare R2 file storage — product photos, logos, documents.
// R2 is S3-compatible so we use the @aws-sdk/client-s3 package.
// All images are stored as their original file type under:
//   {businessId}/products/{uuid}.{ext}
//   {businessId}/logos/{uuid}.{ext}
//   {businessId}/documents/{uuid}.{ext}
//
// Public URL: https://{R2_PUBLIC_URL}/{key}
// (Enable "Public access" on the R2 bucket in the Cloudflare dashboard,
//  or use a custom domain via a Cloudflare Worker / Pages route.)

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  },
})

const BUCKET = process.env.R2_BUCKET_NAME ?? 'zentro-assets'
const PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? '').replace(/\/$/, '')

// Detect the mime type and extension from a base64 data URL or Buffer/stream.
function detectExt(mimeType: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'application/pdf': 'pdf',
  }
  return map[mimeType] ?? 'bin'
}

// Upload a base64 data URL (legacy format from frontend) or raw Buffer to R2.
// Returns the public HTTPS URL for the file, or null on failure.
export async function uploadToR2(
  base64OrBuffer: string | Buffer,
  folder: string,        // e.g. 'products', 'logos', 'documents'
  businessId: string,
): Promise<string | null> {
  try {
    let buffer: Buffer
    let mimeType = 'image/jpeg'

    if (typeof base64OrBuffer === 'string') {
      // Accept data: URLs → strip prefix and decode
      const match = base64OrBuffer.match(/^data:([^;]+);base64,(.+)$/)
      if (match) {
        mimeType = match[1]
        buffer = Buffer.from(match[2], 'base64')
      } else if (base64OrBuffer.startsWith('http')) {
        // Already a URL — nothing to upload
        return base64OrBuffer
      } else {
        // Plain base64 without prefix
        buffer = Buffer.from(base64OrBuffer, 'base64')
      }
    } else {
      buffer = base64OrBuffer
    }

    const ext = detectExt(mimeType)
    const key = `${businessId}/${folder}/${randomUUID()}.${ext}`

    await client.send(new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimeType,
      // Aggressive caching — images don't change at the same URL
      CacheControl: 'public, max-age=31536000, immutable',
    }))

    return `${PUBLIC_URL}/${key}`
  } catch (err) {
    console.error('[R2] upload failed:', err)
    return null
  }
}

// Delete a previously-uploaded file by its public URL.
export async function deleteFromR2(url: string): Promise<void> {
  try {
    if (!url || !url.startsWith(PUBLIC_URL)) return
    const key = url.slice(PUBLIC_URL.length + 1)
    await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
  } catch (err) {
    console.error('[R2] delete failed:', err)
  }
}

// Multipart upload handler — parses an incoming HTTP request with Content-Type:
// multipart/form-data and uploads each file field to R2.
// Returns { fieldName: url } map or throws on error.
export async function handleUpload(
  req: any,                 // IncomingMessage
  res: any,                 // ServerResponse
  folder: string,
  businessId: string,
): Promise<boolean> {
  const ct = req.headers['content-type'] ?? ''
  if (!ct.startsWith('multipart/form-data')) return false

  const boundary = ct.split('boundary=')[1]?.trim()
  if (!boundary) { res.writeHead(400); res.end(JSON.stringify({ error: 'Missing boundary' })); return true }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const body = Buffer.concat(chunks)

  // Simple multipart parser (handles single-file uploads from the frontend)
  const parts = parseMultipart(body, boundary)
  const uploaded: Record<string, string> = {}

  for (const part of parts) {
    if (!part.filename) continue      // skip non-file fields
    const url = await uploadToR2(part.data, folder, businessId)
    if (url) uploaded[part.name] = url
  }

  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(uploaded))
  return true
}

interface Part { name: string; filename?: string; mimeType: string; data: Buffer }

function parseMultipart(body: Buffer, boundary: string): Part[] {
  const sep = Buffer.from(`--${boundary}`)
  const parts: Part[] = []
  let start = 0

  while (start < body.length) {
    const idx = body.indexOf(sep, start)
    if (idx === -1) break
    start = idx + sep.length

    if (body[start] === 0x2d && body[start + 1] === 0x2d) break // --boundary--

    // Skip CRLF after boundary
    if (body[start] === 0x0d) start += 2
    else if (body[start] === 0x0a) start += 1

    // Headers end at \r\n\r\n
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start)
    if (headerEnd === -1) break
    const headerStr = body.slice(start, headerEnd).toString('utf8')
    start = headerEnd + 4

    const next = body.indexOf(sep, start)
    const dataEnd = next === -1 ? body.length : next - 2  // strip trailing CRLF
    const data = body.slice(start, dataEnd)
    start = next === -1 ? body.length : next

    const dispMatch = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/)
    const fileMatch = headerStr.match(/Content-Disposition:[^\r\n]*filename="([^"]+)"/)
    const typeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/)

    parts.push({
      name:     dispMatch?.[1] ?? 'file',
      filename: fileMatch?.[1],
      mimeType: typeMatch?.[1]?.trim() ?? 'application/octet-stream',
      data,
    })
  }
  return parts
}
