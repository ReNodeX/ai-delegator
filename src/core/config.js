import { z } from 'zod'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import dotenv from 'dotenv'
import { logConfig } from './logger.js'

const __filename = fileURLToPath(import.meta.url),
  __dirname = dirname(__filename)

const configPaths = {
  filters: join(__dirname, '../../data/filters.json'),
  prompt: join(__dirname, '../../prompts/classifier.txt')
}

dotenv.config()

const filtersSchema = z.object({
  denyRegex: z.array(z.string()).default([]),
  denyLinks: z.array(z.string()).default([])
})

function loadFilters() {
  try {
    if (existsSync(configPaths.filters)) {
      const data = JSON.parse(readFileSync(configPaths.filters, 'utf8'))
      return filtersSchema.parse(data)
    }
  } catch (err) {
    logConfig.warn({ err }, 'не удалось загрузить filters.json, используются значения по умолчанию')
  }
  return { denyRegex: [], denyLinks: [] }
}

function loadPrompt() {
  try {
    if (existsSync(configPaths.prompt)) {
      return readFileSync(configPaths.prompt, 'utf8').trim()
    }
  } catch (err) {
    logConfig.warn({ err }, 'не удалось загрузить промпт классификатора')
  }
  return null
}

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

export function loadConfig() {
  try {
    const env = {
      TG_API_ID: parseEnvNumber(process.env.TG_API_ID, 0),
      TG_API_HASH: process.env.TG_API_HASH || '',
      TG_SESSION: process.env.TG_SESSION || '',
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
      TIMEZONE: process.env.TIMEZONE || 'Europe/Berlin',
      LOG_LEVEL: process.env.LOG_LEVEL || 'info'
    }

    if (!env.TG_API_ID || !env.TG_API_HASH) {
      logConfig.error('TG_API_ID и TG_API_HASH обязательны в .env')
      process.exit(1)
    }

    if (!env.OPENAI_API_KEY) {
      logConfig.error('OPENAI_API_KEY обязателен в .env')
      process.exit(1)
    }

    const targetGroupId = parseEnvNumber(process.env.TARGET_GROUP_ID, 0)
    if (!targetGroupId) {
      logConfig.error('TARGET_GROUP_ID обязателен в .env')
      process.exit(1)
    }

    const filters = loadFilters(),
      classifierPrompt = loadPrompt()

    const config = {
      backfillDays: parseEnvNumber(process.env.BACKFILL_DAYS, 1),
      target: { groupId: targetGroupId },
      env,
      dialogFilters: {
        exclude: {
          usernames: [],
          ids: [targetGroupId, Math.abs(targetGroupId)],
          types: ['bot', 'user']
        },
        allow: { usernames: [], ids: [], types: ['channel', 'supergroup', 'group'] }
      },
      ai: {
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        minConfidence: parseEnvFloat(process.env.AI_MIN_CONFIDENCE, 0.7),
        languages: ['ru', 'en'],
        rateLimit: { requestsPerMinute: 20, delayBetweenRequests: 3000 }
      },
      filters,
      limits: { maxParallelClassify: 1, maxTgRequestsPerSecond: 5 },
      hashtags: {
        exact: ['#заказ', '#новыйзаказ'],
        normalized: ['#заказ', '#новый_заказ'],
        useNormalized: false
      },
      live: { enable: true, debounceMs: 300, retry: { maxAttempts: 5, baseDelayMs: 500 } },
      classifierPrompt
    }

    logConfig.info(
      {
        backfillDays: config.backfillDays,
        targetGroupId: config.target.groupId,
        aiModel: config.ai.model,
        minConfidence: config.ai.minConfidence,
        hasCustomPrompt: !!classifierPrompt
      },
      'конфигурация загружена из .env'
    )

    return config
  } catch (error) {
    if (error instanceof z.ZodError) {
      const validationErrors = error.errors.map((err) => ({
        path: err.path.join('.'),
        message: err.message
      }))
      logConfig.error({ validationErrors }, 'ошибка валидации конфигурации')
      process.exit(1)
    }
    throw error
  }
}

let configInstance = null

export function getConfig() {
  if (!configInstance) configInstance = loadConfig()
  return configInstance
}

export function getPromptPath() {
  return configPaths.prompt
}
