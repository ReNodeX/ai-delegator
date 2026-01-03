import { getTimeOfDayGreeting } from './sender-time.js'
import OpenAI from 'openai'

const openaiConfig = {
  defaultModel: 'openai/gpt-3.5-turbo',
  defaultMaxTokens: 500,
  defaultTemperature: 0.7,
  portfolioUrl:
    'https://drive.google.com/drive/folders/12obooYu4A0lFtr5iGKc99oXp-0vf-bYP?usp=sharing'
}

export class LeadContext {
  constructor(description, contactKey, sourceMessageId, category) {
    this.description = description
    this.contactKey = contactKey
    this.sourceMessageId = sourceMessageId
    this.category = category
  }
}

export class AIGenerationResult {
  constructor(success, text, usage, error) {
    this.success = success
    this.text = text
    this.usage = usage
    this.error = error
  }
}

export class OpenAIClient {
  constructor(apiKey, rootLogger) {
    this.apiKey = apiKey
    this.rootLogger = rootLogger
  }

  async generateOutreachMessage(leadContext, config) {
    const prompt = this.createPrompt(leadContext),
      openai = new OpenAI({ apiKey: config.apiKey }),
      completion = await openai.chat.completions.create({
        model: config.model || openaiConfig.defaultModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: config.maxTokens || openaiConfig.defaultMaxTokens,
        temperature: config.temperature || openaiConfig.defaultTemperature
      }),
      responseText = completion.choices[0]?.message?.content || ''

    return new AIGenerationResult(
      true,
      responseText,
      {
        prompt_tokens: completion.usage?.prompt_tokens || 0,
        completion_tokens: completion.usage?.completion_tokens || 0,
        total_tokens: completion.usage?.total_tokens || 0
      },
      null
    )
  }

  createPrompt(leadContext) {
    const { description } = leadContext,
      greeting = getTimeOfDayGreeting()

    return `Ты - эксперт по IT-услугам. Напиши ДЕЛОВОЕ ПЕРВОЕ СООБЩЕНИЕ клиенту.

ЗАПРОС КЛИЕНТА: "${description}"

СТРУКТУРА СООБЩЕНИЯ:
1. Приветствие: "${greeting}"
2. Упоминание конкретного запроса клиента (НЕ упоминай откуда узнал)
3. Предложение помощи с указанием экспертизы
4. Ссылка на портфолио (ТОЛЬКО для дизайн-заказов): ${openaiConfig.portfolioUrl}
5. Призыв к действию

ПРАВИЛА:
- МАКСИМАЛЬНО ДЕЛОВОЙ тон
- БЕЗ эмодзи и стикеров
- БЕЗ упоминания чатов, каналов, телеграм
- ОТВЕЧАЙ ТОЛЬКО на то, что просит клиент
- НЕ ПРИДУМЫВАЙ услуги, которых нет в запросе
- ССЫЛКУ НА ПОРТФОЛИО указывай ТОЛЬКО если заказ связан с дизайном
- Для НЕ-дизайн заказов - НЕ указывай ссылку на портфолио

Напиши только текст сообщения.`
  }

  async simulateOpenAIResponse(prompt, category) {
    await new Promise((resolve) => setTimeout(resolve, 200))

    const greeting = getTimeOfDayGreeting(),
      isDesignOrder =
        category &&
        (category.toLowerCase().includes('design') ||
          category.toLowerCase().includes('дизайн') ||
          category.toLowerCase().includes('ui') ||
          category.toLowerCase().includes('ux') ||
          category.toLowerCase().includes('графич') ||
          category.toLowerCase().includes('логотип') ||
          category.toLowerCase().includes('бренд'))

    let responseText = `${greeting}!

Готов помочь с реализацией вашего проекта. Имею опыт в различных IT-направлениях и подберу оптимальное решение под ваши задачи.`

    if (isDesignOrder)
      responseText += `

С портфолио можно ознакомиться: ${openaiConfig.portfolioUrl}`

    responseText += `

Предлагаю обсудить детали в удобное для вас время!`

    return {
      text: responseText,
      usage: {
        prompt_tokens: prompt.length,
        completion_tokens: responseText.length,
        total_tokens: prompt.length + responseText.length
      }
    }
  }
}

export function createOpenAIClient(apiKey, rootLogger) {
  return new OpenAIClient(apiKey, rootLogger)
}
