import { logFilterRules } from '../core/logger.js'

const rulesConfig = {
  defaultRegexFlags: 'i',
  maxTextSampleLen: 200
}

export class FilterRules {
  constructor(config) {
    if (!config?.filters) throw new Error('Конфигурация с фильтрами обязательна')

    const { filters } = config
    this.denyRegex = Array.isArray(filters.denyRegex) ? filters.denyRegex : []
    this.denyLinks = Array.isArray(filters.denyLinks) ? filters.denyLinks : []

    this.compiledDenyRegex = this.denyRegex
      .map((pattern, index) => this.compileRegexPattern(pattern, index))
      .filter(Boolean)

    logFilterRules.info(
      {
        filters: {
          regex: {
            total: this.denyRegex.length,
            compiled: this.compiledDenyRegex.length,
            invalid: this.denyRegex.length - this.compiledDenyRegex.length
          },
          links: { total: this.denyLinks.length }
        }
      },
      'система фильтров инициализирована'
    )
  }

  compileRegexPattern(pattern, index) {
    if (!pattern || typeof pattern !== 'string') {
      logFilterRules.warn(
        { pattern, index, reason: 'неверный тип паттерна' },
        'пропуск невалидного regex'
      )
      return null
    }

    try {
      const compiled = new RegExp(pattern, rulesConfig.defaultRegexFlags)
      logFilterRules.debug(
        { compilation: { pattern, index, compiled: compiled.toString(), flags: compiled.flags } },
        'regex скомпилирован'
      )
      return compiled
    } catch (error) {
      logFilterRules.warn(
        { compilation: { pattern, index, error: error.message } },
        'невалидный regex, пропуск'
      )
      return null
    }
  }

  checkMessage(text) {
    if (!text || typeof text !== 'string') {
      logFilterRules.debug({ text, reason: 'нет контента или неверный тип' }, 'проверка пропущена')
      return { denied: false, reason: 'Нет текстового контента' }
    }

    const textLength = text.length,
      textSample = text.substring(0, rulesConfig.maxTextSampleLen)

    logFilterRules.debug(
      {
        message: { length: textLength, sample: textSample },
        filters: { regex: this.compiledDenyRegex.length, links: this.denyLinks.length }
      },
      'обработка сообщения через фильтры'
    )

    const regexMatch = this.checkRegexPatterns(text, textSample, textLength)
    if (regexMatch) return regexMatch

    const linkMatch = this.checkLinkPatterns(text, textSample, textLength)
    if (linkMatch) return linkMatch

    logFilterRules.debug(
      {
        message: { length: textLength, sample: textSample },
        result: {
          status: 'passed',
          patternsChecked: this.compiledDenyRegex.length + this.denyLinks.length
        }
      },
      'сообщение прошло все фильтры'
    )

    return {
      denied: false,
      reason: 'Прошло все pre-filter правила',
      checkedPatterns: this.compiledDenyRegex.length + this.denyLinks.length
    }
  }

  checkRegexPatterns(text, textSample, textLength) {
    for (let i = 0; i < this.compiledDenyRegex.length; i++) {
      const regex = this.compiledDenyRegex[i],
        pattern = this.denyRegex[i]

      if (regex && regex.test(text)) {
        logFilterRules.info(
          { pattern, textSample, textLength, matchIndex: i },
          'сообщение отклонено по regex'
        )
        return {
          denied: true,
          reason: `Совпадение с deny regex: ${pattern}`,
          pattern,
          matchType: 'regex',
          matchIndex: i
        }
      }
    }
    return null
  }

  checkLinkPatterns(text, textSample, textLength) {
    const textLower = text.toLowerCase()

    for (let i = 0; i < this.denyLinks.length; i++) {
      const link = this.denyLinks[i],
        linkLower = link.toLowerCase()

      if (textLower.includes(linkLower)) {
        logFilterRules.info(
          { link, textSample, textLength, matchIndex: i },
          'сообщение отклонено по ссылке'
        )
        return {
          denied: true,
          reason: `Содержит запрещенную ссылку: ${link}`,
          link,
          matchType: 'link',
          matchIndex: i
        }
      }
    }
    return null
  }

  isDenied(text) {
    const result = this.checkMessage(text)
    logFilterRules.debug(
      { textLength: text?.length || 0, denied: result.denied, reason: result.reason },
      'быстрая проверка выполнена'
    )
    return result.denied
  }

  getPatterns() {
    const { denyRegex, denyLinks, compiledDenyRegex } = this
    return {
      denyRegex,
      denyLinks,
      compiledRegex: compiledDenyRegex.map((regex, index) => ({
        pattern: denyRegex[index],
        compiled: regex.toString(),
        flags: regex.flags
      })),
      stats: {
        totalRegex: denyRegex.length,
        compiledRegex: compiledDenyRegex.length,
        totalLinks: denyLinks.length,
        invalidPatterns: denyRegex.length - compiledDenyRegex.length
      }
    }
  }

  testPatterns(text) {
    if (!text || typeof text !== 'string') {
      logFilterRules.warn({ text }, 'неверный текст для тестирования')
      return { text: 'Неверный текст', tests: [], error: 'Неверный текст' }
    }

    const textLength = text.length,
      textSample =
        text.substring(0, rulesConfig.maxTextSampleLen) +
        (textLength > rulesConfig.maxTextSampleLen ? '...' : ''),
      results = {
        text: textSample,
        textLength,
        tests: [],
        summary: { totalTests: 0, matches: 0, noMatches: 0 }
      }

    logFilterRules.debug(
      {
        textLength,
        textSample,
        regexPatternsCount: this.compiledDenyRegex.length,
        linkPatternsCount: this.denyLinks.length
      },
      'тестирование паттернов'
    )

    this.testRegexPatterns(text, results)
    this.testLinkPatterns(text, results)

    logFilterRules.debug(
      {
        totalTests: results.summary.totalTests,
        matches: results.summary.matches,
        noMatches: results.summary.noMatches
      },
      'тестирование завершено'
    )

    return results
  }

  testRegexPatterns(text, results) {
    this.compiledDenyRegex.forEach((regex, i) => {
      if (regex) {
        const matches = regex.test(text)
        results.tests.push({
          type: 'regex',
          pattern: this.denyRegex[i],
          matches,
          index: i,
          reason: matches ? `Совпадение: ${this.denyRegex[i]}` : 'Нет совпадения'
        })
        results.summary.totalTests++
        matches ? results.summary.matches++ : results.summary.noMatches++
      }
    })
  }

  testLinkPatterns(text, results) {
    const textLower = text.toLowerCase()

    this.denyLinks.forEach((link, i) => {
      const matches = textLower.includes(link.toLowerCase())
      results.tests.push({
        type: 'link',
        pattern: link,
        matches,
        index: i,
        reason: matches ? `Содержит: ${link}` : 'Не найдено'
      })
      results.summary.totalTests++
      matches ? results.summary.matches++ : results.summary.noMatches++
    })
  }
}

export function createFilterRules(config) {
  return new FilterRules(config)
}
