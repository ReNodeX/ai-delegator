import { logTelegramDialogs } from '../core/logger.js'

const dialogConfig = {
  defaultLimit: 1000,
  types: { channel: 'channel', supergroup: 'supergroup', group: 'group', bot: 'bot', user: 'user' }
}

const DEFAULT_FILTERS = {
  exclude: { usernames: [], ids: [], types: ['bot', 'user'] },
  allow: { usernames: [], ids: [], types: ['channel', 'supergroup', 'group'] }
}

export class DialogManager {
  constructor(client, config) {
    if (!client) throw new Error('Telegram клиент обязателен')
    if (!config) throw new Error('Конфигурация обязательна')

    this.client = client
    this.config = config
    this.dialogFilters = config.dialogFilters || DEFAULT_FILTERS

    logTelegramDialogs.info(
      {
        excludeTypes: this.dialogFilters.exclude.types,
        allowTypes: this.dialogFilters.allow.types
      },
      'менеджер диалогов инициализирован'
    )
  }

  async getAllDialogs() {
    const startTime = performance.now()

    try {
      logTelegramDialogs.info('получение всех диалогов из аккаунта')
      const dialogs = await this.client.getDialogs({ limit: dialogConfig.defaultLimit })

      logTelegramDialogs.info({ totalDialogs: dialogs.length }, 'диалоги получены из telegram')

      const filteredDialogs = this.filterDialogs(dialogs),
        excludedCount = dialogs.length - filteredDialogs.length,
        durationMs = Math.round(performance.now() - startTime)

      logTelegramDialogs.info(
        {
          totalDialogs: dialogs.length,
          filteredDialogs: filteredDialogs.length,
          excludedCount,
          durationMs
        },
        'фильтрация диалогов завершена'
      )

      return filteredDialogs
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime)
      logTelegramDialogs.error(
        { err: error, errorMessage: error.message, durationMs },
        'не удалось получить диалоги'
      )
      throw error
    }
  }

  filterDialogs(dialogs) {
    if (!Array.isArray(dialogs)) {
      logTelegramDialogs.warn({ dialogs }, 'неверный массив диалогов')
      return []
    }

    const filtered = [],
      exclusionReasons = { noEntity: 0, excluded: 0, notAllowed: 0 }

    dialogs.forEach((dialog) => {
      const entity = dialog?.entity
      if (!entity) {
        exclusionReasons.noEntity++
        return
      }

      const dialogInfo = this.getDialogInfo(entity)

      if (this.shouldExcludeDialog(dialogInfo)) {
        exclusionReasons.excluded++
        return
      }

      if (!this.shouldAllowDialog(dialogInfo)) {
        exclusionReasons.notAllowed++
        return
      }

      filtered.push({
        entity,
        dialog,
        type: dialogInfo.type,
        username: dialogInfo.username,
        id: dialogInfo.id,
        title: dialogInfo.title
      })
    })

    logTelegramDialogs.debug(
      { totalDialogs: dialogs.length, filteredDialogs: filtered.length, exclusionReasons },
      'фильтрация диалогов завершена'
    )

    return filtered
  }

  getDialogInfo(entity) {
    if (!entity || typeof entity !== 'object')
      return { type: 'unknown', username: null, id: null, title: 'Неверная сущность' }

    const info = {
      type: 'unknown',
      username: entity.username || null,
      id: entity.id?.toString() || null,
      title: entity.title || entity.firstName || entity.lastName || 'Unknown'
    }

    if (entity.className === 'Channel')
      info.type = entity.broadcast ? dialogConfig.types.channel : dialogConfig.types.supergroup
    else if (entity.className === 'Chat') info.type = dialogConfig.types.group
    else if (entity.className === 'User')
      info.type = entity.bot ? dialogConfig.types.bot : dialogConfig.types.user

    return info
  }

  shouldExcludeDialog(dialogInfo) {
    if (!dialogInfo || typeof dialogInfo !== 'object') return true
    const { exclude } = this.dialogFilters

    if (exclude.types.includes(dialogInfo.type)) return true
    if (dialogInfo.username && exclude.usernames.includes(dialogInfo.username)) return true

    if (dialogInfo.id) {
      const dialogId = parseInt(dialogInfo.id, 10)
      if (!isNaN(dialogId) && exclude.ids.includes(dialogId)) return true
    }

    return false
  }

  shouldAllowDialog(dialogInfo) {
    if (!dialogInfo || typeof dialogInfo !== 'object') return false
    const { allow } = this.dialogFilters

    if (allow.usernames.length === 0 && allow.ids.length === 0 && allow.types.length === 0)
      return true
    if (allow.types.length > 0 && !allow.types.includes(dialogInfo.type)) return false

    return true
  }

  getDialogStats(dialogs) {
    if (!Array.isArray(dialogs))
      return { total: 0, byType: {}, withUsername: 0, withoutUsername: 0, error: 'Неверный ввод' }

    const stats = { total: dialogs.length, byType: {}, withUsername: 0, withoutUsername: 0 }

    dialogs.forEach((dialog) => {
      const type = dialog.type || 'unknown'
      stats.byType[type] = (stats.byType[type] || 0) + 1
      dialog.username ? stats.withUsername++ : stats.withoutUsername++
    })

    return stats
  }

  testFiltering(sampleDialogs = []) {
    if (!Array.isArray(sampleDialogs))
      return {
        config: this.dialogFilters,
        sampleDialogs: 0,
        filtered: [],
        excluded: [],
        error: 'Неверный ввод'
      }

    const results = {
      config: this.dialogFilters,
      sampleDialogs: sampleDialogs.length,
      filtered: [],
      excluded: []
    }

    sampleDialogs.forEach((dialog) => {
      const dialogInfo = this.getDialogInfo(dialog),
        shouldExclude = this.shouldExcludeDialog(dialogInfo),
        shouldAllow = this.shouldAllowDialog(dialogInfo),
        finalDecision = !shouldExclude && shouldAllow,
        result = { ...dialogInfo, shouldExclude, shouldAllow, finalDecision }

      finalDecision ? results.filtered.push(result) : results.excluded.push(result)
    })

    return results
  }
}

export function createDialogManager(client, config) {
  return new DialogManager(client, config)
}
