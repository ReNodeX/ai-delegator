import OpenAI from 'openai'
import PQueue from 'p-queue'
import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { logFilterOpenai } from '../core/logger.js'

const __filename = fileURLToPath(import.meta.url),
  __dirname = dirname(__filename)

const classifierConfig = {
  defaultModel: 'gpt-4o-mini',
  defaultMinConfidence: 0.75,
  defaultLanguages: ['ru', 'en'],
  maxTextLen: 4000,
  maxOutputTokens: 1000,
  confidencePrecision: 100,
  truncationBuffer: 3,
  minTruncationRatio: 0.8,
  retry429DelayMs: 5 * 60 * 1000,
  queueConcurrency: 1,
  queueIntervalMs: 3000,
  queueIntervalCap: 1
}

const OPENAI_API_BASE_URL = 'https://api.openai.com/v1',
  PROMPT_PATH = join(__dirname, '../../prompts/classifier.txt')

const VALID_CATEGORIES = [
  'web',
  'bot',
  'crm_integration',
  'ai_automation',
  'design',
  'content_media',
  'marketing',
  'support_sla',
  'other'
]

const DEFAULT_SYSTEM_PROMPT = `You are a LEAD CLASSIFICATION SYSTEM for a digital agency.

Your task: analyze each message and decide if it's a **LEAD** (someone seeking digital services) or **NOT a lead** (self-promotion, spam, or unrelated).

## LEAD criteria (someone NEEDING services)
Mark as LEAD (isLead=true) if the message clearly or implicitly shows that the person or company **needs a service or a solution to be done FOR THEM**.

A message qualifies as a LEAD if it matches any of the following:
- They are looking for someone to DO, MAKE, DEVELOP, or DESIGN something for them.
- They ask for quotes, timelines, or pricing.
- They ask who can help implement or build something.
- They request automation, integrations, CRM setups, websites, bots, or creative work.
- They use phrases like: "I need", "I want", "We're looking for", "Can someone help".
- They're trying to solve a business or technical problem and need outside help or contractors.
- They mention a project, task, or need but don't offer their own services.

## NOT LEAD criteria (someone OFFERING services)
Mark as NOT LEAD (isLead=false) if the author is:
- Offering, selling, or advertising their own services.
- A freelancer or agency promoting themselves.
- Sharing a portfolio, Behance, GitHub, or Telegram channel.
- Saying things like "I can help", "I offer", "I'm available", "My portfolio".
- Describing their skills, experience, or prices.
- Looking for work, employment, or clients.
- Posting job ads or hiring announcements.

## ADVERTISING / SPAM (NOT leads)
Always mark as NOT LEAD if message contains:
- Channel, group, or promotion ads.
- Bulk messaging, promotion of mass mailing.
- Employment offers or hiring posts.
- Crypto, betting, gambling, or unrelated topics.
- Price lists, MLM, giveaways, promo posts, link farms.
- Job postings.

## CATEGORY definitions (for valid leads only)
If isLead=true, choose one relevant category:

- **web** - websites, landing pages, personal accounts, web-apps, front/back-end.
- **bot** - Telegram/WhatsApp bots, AI chatbots, auto-replies, scripts.
- **crm_integration** - Bitrix24, amoCRM, 1C, Planfix, retailCRM, API, webhooks, SIP, telephony, payments.
- **ai_automation** - AI assistants, neural networks, auto-response, automation scenarios, GPT, OpenAI, ML tasks.
- **design** - UI/UX, product design, branding, visual identity, logo, media kit.
- **content_media** - video editing, promo reels, case packaging, copywriting, SMM creatives.
- **marketing** - SEO, ads, performance, e-commerce marketing, funnels, analytics, growth.
- **support_sla** - tech support, maintenance, monitoring, SLA requests, devops tasks.
- **other** - any unclear but likely business-service request.

## OUTPUT format (strict)
Respond **only** with valid JSON:
{
  "isLead": true/false,
  "confidence": 0.0-1.0,
  "category": "web|bot|crm_integration|ai_automation|design|content_media|marketing|support_sla|other",
  "reason": "Brief explanation why it's a lead or not"
}`

function loadPromptFromFile() {
  try {
    if (existsSync(PROMPT_PATH)) return readFileSync(PROMPT_PATH, 'utf8').trim()
  } catch (err) {
    logFilterOpenai.warn(
      { err, path: PROMPT_PATH },
      'не удалось загрузить файл промпта, используется default'
    )
  }
  return null
}

export class OpenAIClassifier {
  constructor(apiKey, config) {
    if (!apiKey || typeof apiKey !== 'string')
      throw new Error('Валидный OpenAI API ключ обязателен')
    if (!config?.ai) throw new Error('Конфигурация с AI настройками обязательна')

    const { ai } = config
    this.apiKey = apiKey
    this.model = ai.model || classifierConfig.defaultModel
    this.minConfidence = Math.max(
      0,
      Math.min(1, ai.minConfidence || classifierConfig.defaultMinConfidence)
    )
    this.languages = Array.isArray(ai.languages) ? ai.languages : classifierConfig.defaultLanguages
    this.systemPrompt = config.classifierPrompt || loadPromptFromFile() || DEFAULT_SYSTEM_PROMPT

    this.openai = new OpenAI({ apiKey: this.apiKey, baseURL: OPENAI_API_BASE_URL })

    this.queue = new PQueue({
      concurrency: classifierConfig.queueConcurrency,
      interval: classifierConfig.queueIntervalMs,
      intervalCap: classifierConfig.queueIntervalCap
    })

    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      queuedRequests: 0,
      leadsFound: 0,
      averageConfidence: 0,
      startTime: Date.now()
    }

    logFilterOpenai.info(
      {
        configuration: {
          model: this.model,
          minConfidence: this.minConfidence,
          languages: this.languages,
          baseURL: OPENAI_API_BASE_URL,
          promptSource: config.classifierPrompt
            ? 'config'
            : existsSync(PROMPT_PATH)
              ? 'file'
              : 'default',
          limits: {
            maxTextLen: classifierConfig.maxTextLen,
            maxOutputTokens: classifierConfig.maxOutputTokens
          }
        }
      },
      'OpenAI классификатор инициализирован'
    )
  }

  async classify(text) {
    this.stats.totalRequests++
    this.stats.queuedRequests++

    logFilterOpenai.info(
      { queue: { queued: this.stats.queuedRequests, total: this.stats.totalRequests } },
      'запрос добавлен в очередь AI классификации'
    )

    return this.queue.add(async () => {
      try {
        this.stats.queuedRequests--
        this.stats.successfulRequests++
        logFilterOpenai.info(
          {
            queue: { processed: this.stats.successfulRequests, queued: this.stats.queuedRequests }
          },
          'обработка запроса AI классификации'
        )
        return await this._classifyMessage(text)
      } catch (error) {
        this.stats.failedRequests++
        logFilterOpenai.error('openai-queue', 'ошибка обработки запроса AI классификации', {
          error: error.message
        })
        throw error
      }
    })
  }

  async _classifyMessage(text) {
    const startTime = performance.now()
    let didRetryOn429 = false

    if (!text || typeof text !== 'string') {
      logFilterOpenai.warn({ text }, 'неверный текст для классификации')
      return this.createDefaultResult('Нет текстового контента')
    }

    try {
      const truncatedText = this.truncateText(text, classifierConfig.maxTextLen),
        messages = this.buildMessages(truncatedText)

      logFilterOpenai.debug(
        {
          textLength: text.length,
          truncatedLength: truncatedText.length,
          wasTruncated: truncatedText.length < text.length
        },
        'отправка запроса классификации в openai'
      )

      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages,
        max_tokens: classifierConfig.maxOutputTokens,
        temperature: 0,
        response_format: { type: 'json_object' }
      })

      const responseText = response.choices[0]?.message?.content

      logFilterOpenai.debug(
        {
          responseLength: responseText?.length || 0,
          responseSample: responseText?.substring(0, 200)
        },
        'получен ответ openai'
      )

      const classification = this.parseResponse(responseText)

      if (classification.valid && classification.isLead) this.stats.leadsFound++

      if (classification.valid) {
        const { successfulRequests } = this.stats
        this.stats.averageConfidence =
          (this.stats.averageConfidence * (successfulRequests - 1) + classification.confidence) /
          successfulRequests
      }

      const durationMs = Math.round(performance.now() - startTime)
      logFilterOpenai.info(
        {
          isLead: classification.isLead,
          confidence: classification.confidence,
          category: classification.category,
          valid: classification.valid,
          meetsThreshold: this.meetsThreshold(classification),
          textLength: text.length,
          durationMs
        },
        'классификация завершена'
      )

      return classification
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime),
        isRateLimited =
          error?.status === 429 ||
          error?.code === 'insufficient_quota' ||
          /429/.test(error?.message || '')

      if (isRateLimited && !didRetryOn429) {
        didRetryOn429 = true
        logFilterOpenai.warn(
          { waitMs: classifierConfig.retry429DelayMs, reason: error?.message },
          'rate limit от OpenAI (429). ожидание перед повтором'
        )

        await new Promise((resolve) => setTimeout(resolve, classifierConfig.retry429DelayMs))

        try {
          const retryStart = performance.now(),
            truncatedText = this.truncateText(text, classifierConfig.maxTextLen),
            retryMessages = this.buildMessages(truncatedText)

          const retryResponse = await this.openai.chat.completions.create({
            model: this.model,
            messages: retryMessages,
            max_tokens: classifierConfig.maxOutputTokens,
            temperature: 0,
            response_format: { type: 'json_object' }
          })

          const retryResponseText = retryResponse.choices[0]?.message?.content,
            retryClassification = this.parseResponse(retryResponseText),
            retryDurationMs = Math.round(performance.now() - retryStart)

          logFilterOpenai.info(
            {
              retry: true,
              durationMs: retryDurationMs,
              valid: retryClassification.valid,
              isLead: retryClassification.isLead,
              confidence: retryClassification.confidence
            },
            'классификация завершена после повтора 429'
          )

          return retryClassification
        } catch (retryError) {
          logFilterOpenai.error(
            { err: retryError, errorMessage: retryError.message, errorCode: retryError.code },
            'повтор классификации после 429 не удался'
          )
          return this.createDefaultResult(
            `Ошибка классификации после повтора 429: ${retryError.message}`
          )
        }
      }

      logFilterOpenai.error(
        {
          err: error,
          errorMessage: error.message,
          errorCode: error.code,
          textLength: text?.length || 0,
          textSample: text?.substring(0, 100) + '...',
          durationMs
        },
        'классификация не удалась'
      )

      return this.createDefaultResult(`Ошибка классификации: ${error.message}`)
    }
  }

  getQueueStats() {
    return { ...this.stats, queueSize: this.queue.size, pending: this.queue.pending }
  }

  buildMessages(text) {
    return [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: `Message to analyze (${this.languages.join(', ')}):\n"${text}"` }
    ]
  }

  parseResponse(response) {
    try {
      if (!response || typeof response !== 'string') throw new Error('Неверный ответ')

      const parsed = JSON.parse(response)

      logFilterOpenai.debug(
        { responseLength: response.length, parsedKeys: Object.keys(parsed) },
        'парсинг ответа openai'
      )

      if (typeof parsed.isLead !== 'boolean')
        throw new Error(`Неверное поле isLead: ${typeof parsed.isLead}, значение: ${parsed.isLead}`)
      if (typeof parsed.confidence !== 'number' || parsed.confidence < 0 || parsed.confidence > 1)
        throw new Error(`Неверное поле confidence: ${parsed.confidence}`)

      if (!parsed.category || typeof parsed.category !== 'string') {
        logFilterOpenai.warn(
          { category: parsed.category, reason: 'null или неверная категория' },
          'используется "other"'
        )
        parsed.category = 'other'
      }

      if (!VALID_CATEGORIES.includes(parsed.category)) {
        logFilterOpenai.warn(
          { category: parsed.category, validCategories: VALID_CATEGORIES },
          'неизвестная категория, используется "other"'
        )
        parsed.category = 'other'
      }

      if (!parsed.reason || typeof parsed.reason !== 'string')
        throw new Error(`Неверное поле reason: ${parsed.reason}`)

      const result = {
        isLead: parsed.isLead,
        confidence:
          Math.round(parsed.confidence * classifierConfig.confidencePrecision) /
          classifierConfig.confidencePrecision,
        category: parsed.category,
        reason: parsed.reason,
        valid: true
      }

      logFilterOpenai.debug(
        {
          isLead: result.isLead,
          confidence: result.confidence,
          category: result.category,
          reasonLength: result.reason.length
        },
        'ответ успешно распарсен'
      )

      return result
    } catch (error) {
      logFilterOpenai.warn(
        {
          err: error,
          errorMessage: error.message,
          responseLength: response?.length || 0,
          responseSample: response?.substring(0, 200) + '...'
        },
        'не удалось распарсить ответ openai'
      )
      return this.createDefaultResult(`Ошибка парсинга: ${error.message}`)
    }
  }

  createDefaultResult(reason) {
    logFilterOpenai.debug(
      { reason, reasonLength: reason?.length || 0 },
      'создание результата классификации по умолчанию'
    )
    return {
      isLead: false,
      confidence: 0.0,
      category: 'other',
      reason: reason || 'Неизвестная ошибка',
      valid: false
    }
  }

  truncateText(text, maxLength) {
    if (!text || typeof text !== 'string') {
      logFilterOpenai.warn({ text, maxLength }, 'неверный текст для обрезки')
      return ''
    }

    if (text.length <= maxLength) return text

    logFilterOpenai.debug(
      { originalLength: text.length, maxLength, truncationNeeded: true },
      'обрезка текста для openai'
    )

    let cutPoint = maxLength - classifierConfig.truncationBuffer
    const sentenceEndings = ['.', '!', '?']

    while (cutPoint > 0 && !sentenceEndings.includes(text[cutPoint])) cutPoint--

    if (cutPoint < maxLength * classifierConfig.minTruncationRatio)
      cutPoint = maxLength - classifierConfig.truncationBuffer

    const truncated = text.substring(0, cutPoint).trim() + '...'

    logFilterOpenai.debug(
      {
        originalLength: text.length,
        finalLength: truncated.length,
        cutPoint,
        savedChars: text.length - truncated.length
      },
      'текст обрезан для openai'
    )

    return truncated
  }

  meetsThreshold(classification) {
    if (!classification || typeof classification !== 'object') return false

    const meets =
      classification.valid &&
      classification.isLead &&
      classification.confidence >= this.minConfidence

    logFilterOpenai.debug(
      {
        valid: classification.valid,
        isLead: classification.isLead,
        confidence: classification.confidence,
        minConfidence: this.minConfidence,
        meets
      },
      'проверка порога выполнена'
    )

    return meets
  }

  getConfig() {
    return {
      model: this.model,
      minConfidence: this.minConfidence,
      languages: this.languages,
      maxTextLen: classifierConfig.maxTextLen,
      maxOutputTokens: classifierConfig.maxOutputTokens
    }
  }

  getStats() {
    const { totalRequests, successfulRequests, leadsFound, startTime } = this.stats,
      duration = Date.now() - startTime,
      successRate = totalRequests > 0 ? Math.round((successfulRequests / totalRequests) * 100) : 0,
      leadRate = successfulRequests > 0 ? Math.round((leadsFound / successfulRequests) * 100) : 0

    return {
      ...this.stats,
      successRate,
      leadRate,
      duration,
      avgRequestsPerMinute:
        duration > 0 ? Math.round((totalRequests / (duration / 60000)) * 100) / 100 : 0
    }
  }
}

export function createOpenAIClassifier(apiKey, config) {
  return new OpenAIClassifier(apiKey, config)
}
