import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { logTelegram } from './logger.js'

const __filename = fileURLToPath(import.meta.url),
  __dirname = dirname(__filename)

const scannerConfig = {
  chatsFile: join(__dirname, '../../data/chats.json'),
  scanIntervalMs: 10 * 60 * 1000,
  allowedTypes: ['group', 'supergroup', 'channel'],
  dialogsLimit: 500
}

function loadChats() {
  try {
    if (existsSync(scannerConfig.chatsFile)) {
      return JSON.parse(readFileSync(scannerConfig.chatsFile, 'utf8'))
    }
  } catch (err) {
    logTelegram.warn({ err }, 'не удалось загрузить chats.json')
  }
  return { chats: [], lastScan: null }
}

function saveChats(data) {
  try {
    writeFileSync(scannerConfig.chatsFile, JSON.stringify(data, null, 2))
    logTelegram.info({ count: data.chats.length }, 'чаты сохранены в файл')
  } catch (err) {
    logTelegram.error({ err }, 'не удалось сохранить chats.json')
  }
}

function getChatType(dialog) {
  const { entity } = dialog
  if (!entity) return null

  if (entity.className === 'Channel') return entity.megagroup ? 'supergroup' : 'channel'
  if (entity.className === 'Chat') return 'group'
  if (entity.className === 'User') return entity.bot ? 'bot' : 'user'
  return null
}

function formatChat(dialog) {
  const { entity } = dialog,
    type = getChatType(dialog)

  return {
    id: entity.id.toString(),
    accessHash: entity.accessHash?.toString() || null,
    title: entity.title || entity.firstName || 'Unknown',
    username: entity.username || null,
    type,
    participantsCount: entity.participantsCount || null,
    scannedAt: new Date().toISOString()
  }
}

export async function scanChats(client) {
  logTelegram.info('запуск сканирования чатов')

  try {
    const dialogs = await client.getDialogs({ limit: scannerConfig.dialogsLimit }),
      chats = []

    dialogs.forEach((dialog) => {
      const type = getChatType(dialog)
      if (type && scannerConfig.allowedTypes.includes(type)) {
        chats.push(formatChat(dialog))
      }
    })

    const data = {
      chats,
      lastScan: new Date().toISOString(),
      totalFound: chats.length
    }

    saveChats(data)

    logTelegram.info(
      {
        total: dialogs.length,
        groups: chats.filter((c) => c.type === 'group').length,
        supergroups: chats.filter((c) => c.type === 'supergroup').length,
        channels: chats.filter((c) => c.type === 'channel').length
      },
      'сканирование чатов завершено'
    )

    return data
  } catch (err) {
    logTelegram.error({ err }, 'ошибка сканирования чатов')
    throw err
  }
}

export async function syncChats(client) {
  logTelegram.info('синхронизация чатов')

  const existing = loadChats(),
    existingIds = new Set(existing.chats.map((c) => c.id))

  try {
    const dialogs = await client.getDialogs({ limit: scannerConfig.dialogsLimit }),
      currentChats = [],
      currentIds = new Set()

    dialogs.forEach((dialog) => {
      const type = getChatType(dialog)
      if (type && scannerConfig.allowedTypes.includes(type)) {
        const chat = formatChat(dialog)
        currentChats.push(chat)
        currentIds.add(chat.id)
      }
    })

    const added = currentChats.filter((c) => !existingIds.has(c.id)),
      removed = existing.chats.filter((c) => !currentIds.has(c.id))

    if (added.length > 0) {
      logTelegram.info(
        { count: added.length, chats: added.map((c) => c.title) },
        'найдены новые чаты'
      )
    }

    if (removed.length > 0) {
      logTelegram.info(
        { count: removed.length, chats: removed.map((c) => c.title) },
        'чаты удалены'
      )
    }

    const data = {
      chats: currentChats,
      lastScan: new Date().toISOString(),
      totalFound: currentChats.length
    }

    saveChats(data)

    return { added, removed, total: currentChats.length }
  } catch (err) {
    logTelegram.error({ err }, 'ошибка синхронизации чатов')
    throw err
  }
}

export function startChatsScanner(client) {
  logTelegram.info(
    {
      intervalMs: scannerConfig.scanIntervalMs,
      intervalMin: scannerConfig.scanIntervalMs / 60000
    },
    'запуск сканера чатов'
  )

  scanChats(client).catch((err) => {
    logTelegram.error({ err }, 'ошибка начального сканирования')
  })

  return setInterval(async () => {
    try {
      await syncChats(client)
    } catch (err) {
      logTelegram.error({ err }, 'ошибка плановой синхронизации')
    }
  }, scannerConfig.scanIntervalMs)
}

export function getChats() {
  return loadChats()
}

export function getChatById(id) {
  const data = loadChats()
  return data.chats.find((c) => c.id === id.toString())
}

export function getChatsByType(type) {
  const data = loadChats()
  return data.chats.filter((c) => c.type === type)
}
