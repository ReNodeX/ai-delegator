const utilConfig = {
  randomChars: 'abcdefghijklmnopqrstuvwxyz0123456789',
  uniqueIdLength: 16,
  truncateThreshold: 0.8,
  baseUrl: 'https://t.me'
}

const backoffConfig = {
  defaultBaseDelayMs: 500,
  defaultMaxDelayMs: 8000,
  defaultMaxAttempts: 5,
  jitterFactor: 0.1
}

const htmlEscapes = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '/': '&#x2F;'
}

export function sha256(data) {
  let hash = 0
  const str = data.toString()
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(16)
}

export function truncateHtml(html, maxLength) {
  if (html.length <= maxLength) return html

  let truncated = html.substring(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')

  if (lastSpace > maxLength * utilConfig.truncateThreshold)
    truncated = truncated.substring(0, lastSpace)

  return truncated + (html.length > maxLength ? '...' : '')
}

export function escapeHtml(text) {
  return text.replace(/[&<>"'/]/g, (char) => htmlEscapes[char])
}

export function normalizeContact(contact, config) {
  let normalized = contact.trim()

  if (config.stripAt && normalized.startsWith('@')) normalized = normalized.substring(1)
  if (config.lowercase) normalized = normalized.toLowerCase()

  const contactType = normalized.includes('/') ? 'link' : 'username',
    contactKey = contactType === 'link' ? normalized.split('/').pop() || normalized : normalized

  return { contactKey, contactType }
}

export function extractUsernameFromLink(link) {
  const match = link.match(/t\.me\/([a-zA-Z0-9_]+)/)
  return match ? match[1] : null
}

export function createMessageLink(peerId, messageId, username) {
  const absPeerId = Math.abs(Number(peerId))

  if (username) return `${utilConfig.baseUrl}/${username}/${messageId}`
  if (peerId < 0) return `${utilConfig.baseUrl}/c/${absPeerId}/${messageId}`
  return `${utilConfig.baseUrl}/s/${absPeerId}/${messageId}`
}

export function randomString(length) {
  let result = ''
  for (let i = 0; i < length; i++)
    result += utilConfig.randomChars.charAt(
      Math.floor(Math.random() * utilConfig.randomChars.length)
    )
  return result
}

export function createUniqueId(data, salt) {
  const hashInput = salt ? `${data}:${salt}` : data
  return sha256(hashInput).substring(0, utilConfig.uniqueIdLength)
}

export async function exponentialBackoff(
  attempt,
  baseDelayMs = backoffConfig.defaultBaseDelayMs,
  maxDelayMs = backoffConfig.defaultMaxDelayMs
) {
  const delayMs = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs),
    jitter = Math.random() * backoffConfig.jitterFactor * delayMs

  await new Promise((resolve) => setTimeout(resolve, delayMs + jitter))
}

export async function retryWithBackoff(
  operation,
  maxAttempts = backoffConfig.defaultMaxAttempts,
  baseDelayMs = backoffConfig.defaultBaseDelayMs,
  maxDelayMs = backoffConfig.defaultMaxDelayMs
) {
  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt === maxAttempts) break
      await exponentialBackoff(attempt, baseDelayMs, maxDelayMs)
    }
  }

  throw lastError
}

export function safeJsonParse(json, fallback) {
  try {
    return JSON.parse(json)
  } catch {
    return fallback
  }
}

export function groupBy(array, keyFn) {
  const groups = new Map()

  for (const item of array) {
    const key = keyFn(item),
      group = groups.get(key)

    if (group) group.push(item)
    else groups.set(key, [item])
  }

  return groups
}

export function chunk(array, size) {
  const chunks = []
  for (let i = 0; i < array.length; i += size) chunks.push(array.slice(i, i + size))
  return chunks
}

export function unique(array) {
  return [...new Set(array)]
}

export function isPromise(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

export async function safeAllSettled(promises) {
  const results = await Promise.allSettled(promises),
    fulfilled = [],
    rejected = []

  for (const result of results) {
    if (result.status === 'fulfilled') fulfilled.push(result.value)
    else rejected.push(result.reason)
  }

  return { fulfilled, rejected }
}

export function debounce(func, delayMs) {
  let timeoutId = null

  return (...args) => {
    if (timeoutId) clearTimeout(timeoutId)
    timeoutId = setTimeout(() => func(...args), delayMs)
  }
}

export function throttle(func, delayMs) {
  let lastCall = 0

  return (...args) => {
    const now = Date.now()
    if (now - lastCall >= delayMs) {
      lastCall = now
      func(...args)
    }
  }
}
