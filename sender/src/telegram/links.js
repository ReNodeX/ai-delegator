import { createMessageLink } from '../core/util.js'

const linksConfig = {
  timezone: 'Europe/Moscow',
  locale: 'ru-RU'
}

export function createMessageHtmlLink(peerId, messageId, text, username) {
  const url = createMessageLink(peerId, messageId, username),
    displayText = text || `Сообщение ${messageId}`

  return `<a href="${url}">${displayText}</a>`
}

export function createContactHtmlLink(contact, displayText) {
  const url = contact.startsWith('@')
    ? `https://t.me/${contact.substring(1)}`
    : contact.startsWith('t.me/')
      ? `https://${contact}`
      : `https://t.me/${contact}`

  const text = displayText || contact
  return `<a href="${url}">${text}</a>`
}

export function createReportMessageLink(sourcePeerId, sourceMessageId, contact) {
  const messageLink = createMessageHtmlLink(sourcePeerId, sourceMessageId, 'лид', undefined)

  return `— Контакт: <code>${contact}</code>\n— Источник: ${messageLink}`
}

export function createOutreachReportHtml(
  contact,
  sourcePeerId,
  sourceMessageId,
  templateId,
  status,
  errorMessage
) {
  const timestamp = new Date().toLocaleString(linksConfig.locale, {
      timeZone: linksConfig.timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }),
    messageLink = createReportMessageLink(sourcePeerId, sourceMessageId, contact),
    statusHtml = status === 'OK' ? '<b>OK</b>' : '<b style="color: red;">ОШИБКА</b>'

  let html = `<b>Отправлено первое сообщение</b>

${messageLink}
— Время (МСК): <i>${timestamp}</i>
— Шаблон: <code>${templateId}</code>
— Статус: ${statusHtml}`

  if (errorMessage) html += `\n— Ошибка: ${errorMessage}`

  return html
}

export function createSkipReportHtml(contact, reason) {
  const timestamp = new Date().toLocaleString(linksConfig.locale, {
    timeZone: linksConfig.timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

  return `<b>Пропуск (уже писали)</b>

— Контакт: <code>${contact}</code>
— Причина: ${reason}
— Время (МСК): <i>${timestamp}</i>`
}
