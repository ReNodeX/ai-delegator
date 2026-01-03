import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import dotenv from 'dotenv'
import { isInSenderWorkWindow } from './sender-time.js'

dotenv.config()

function parseEnvNumber(value, defaultValue) {
  if (!value) return defaultValue
  const num = parseInt(value, 10)
  return isNaN(num) ? defaultValue : num
}

function parseEnvFloat(value, defaultValue) {
  if (!value) return defaultValue
  const num = parseFloat(value)
  return isNaN(num) ? defaultValue : num
}

function loadMessagePrompt() {
  const promptPath = join(process.cwd(), 'prompts', 'outreach.txt')
  try {
    if (existsSync(promptPath)) return readFileSync(promptPath, 'utf8').trim()
  } catch {
    console.warn('Не удалось загрузить outreach prompt, используем default')
  }
  return null
}

export function loadConfig() {
  const parserApiId = parseEnvNumber(process.env.TG_PARSER_API_ID, 0),
    parserApiHash = process.env.TG_PARSER_API_HASH || '',
    parserSession = process.env.TG_PARSER_SESSION || '',
    senderApiId = parseEnvNumber(process.env.TG_SENDER_API_ID, 0),
    senderApiHash = process.env.TG_SENDER_API_HASH || '',
    senderSession = process.env.TG_SENDER_SESSION || ''

  if (!parserApiId || !parserApiHash) {
    console.error('TG_PARSER_API_ID и TG_PARSER_API_HASH обязательны')
    process.exit(1)
  }

  if (!senderApiId || !senderApiHash) {
    console.error('TG_SENDER_API_ID и TG_SENDER_API_HASH обязательны')
    process.exit(1)
  }

  const openaiKey = process.env.OPENAI_API_KEY || ''
  if (!openaiKey) {
    console.error('OPENAI_API_KEY обязателен')
    process.exit(1)
  }

  const leadInboxPeerId = parseEnvNumber(process.env.LEAD_INBOX_PEER_ID, 0),
    leadInboxTopicId = parseEnvNumber(process.env.LEAD_INBOX_TOPIC_ID, 1),
    reportPeerId = parseEnvNumber(process.env.REPORT_PEER_ID, 0),
    reportTopicId = parseEnvNumber(process.env.REPORT_TOPIC_ID, 0)

  if (!leadInboxPeerId) {
    console.error('LEAD_INBOX_PEER_ID обязателен')
    process.exit(1)
  }

  const effectiveReportPeerId = reportPeerId || leadInboxPeerId,
    effectiveReportTopicId = reportTopicId || leadInboxTopicId

  if (!reportTopicId && leadInboxTopicId) {
    console.warn(
      'REPORT_TOPIC_ID не указан, уведомления будут отправляться в топик лидов (LEAD_INBOX_TOPIC_ID)'
    )
  }

  const outreachPrompt = loadMessagePrompt()

  return {
    timezoneApp: process.env.TIMEZONE || 'Europe/Berlin',
    sender: {
      timezone: process.env.SENDER_TIMEZONE || 'Europe/Moscow',
      window: {
        start: process.env.WORK_WINDOW_START || '00:00',
        end: process.env.WORK_WINDOW_END || '23:59'
      },
      rateLimit: {
        maxMessages: parseEnvNumber(process.env.RATE_LIMIT_MAX_MESSAGES, 3),
        messageIntervalMs: [
          parseEnvNumber(process.env.RATE_LIMIT_INTERVAL_MIN, 90000),
          parseEnvNumber(process.env.RATE_LIMIT_INTERVAL_MAX, 180000)
        ],
        burstPauseMs: parseEnvNumber(process.env.RATE_LIMIT_BURST_PAUSE, 1800000),
        floodWaitRetries: 3,
        floodWaitDelay: 300000
      },
      leadInbox: { peerId: leadInboxPeerId, topicTopMsgId: leadInboxTopicId },
      report: { peerId: effectiveReportPeerId, topicTopMsgId: effectiveReportTopicId },
      scan: {
        enabled: true,
        backfill: false,
        startFromOldest: false,
        resumeFromCheckpoint: true,
        batchSize: 5,
        delayBetweenBatches: 60000,
        maxRetries: 3,
        retryDelay: 120000,
        realtime: {
          enabled: true,
          intervalMinutes: [2, 3],
          maxNewMessages: 15,
          floodWaitDelay: 60000,
          maxFloodWaitRetries: 3
        }
      },
      contactPatterns: ['@[a-zA-Z0-9_]{4,}', 't\\.me\\/[a-zA-Z0-9_]{4,}(?:\\/[0-9]+)?'],
      dedupe: { normalizeUsernames: true, stripAt: true, lowercase: true },
      message: { templateId: 'lead_v1', uniqueVariantSalt: true },
      openai: {
        apiKey: openaiKey,
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        maxTokens: parseEnvNumber(process.env.OPENAI_MAX_TOKENS, 500),
        temperature: parseEnvFloat(process.env.OPENAI_TEMPERATURE, 0.7)
      },
      telegram: {
        parser: { apiId: parserApiId, apiHash: parserApiHash, session: parserSession },
        sender: { apiId: senderApiId, apiHash: senderApiHash, session: senderSession }
      },
      logging: { level: process.env.LOG_LEVEL || 'info', debugPeers: [] },
      sync: { enabled: true, intervalMinutes: 15, maxNewContacts: 50 },
      outreachPrompt
    }
  }
}

export function getSenderConfig(config) {
  return config.sender
}

export function getTelegramConfig(config) {
  return config.sender.telegram
}

export function isInWorkWindow(config) {
  return isInSenderWorkWindow(config.sender)
}
