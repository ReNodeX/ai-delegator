import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

dayjs.extend(utc)
dayjs.extend(timezone)

const timeConfig = {
  moscowTimezone: 'Europe/Moscow',
  dateFormat: 'DD.MM.YYYY HH:mm'
}

const greetingHours = {
  morningStart: 5,
  morningEnd: 12,
  afternoonEnd: 17,
  eveningEnd: 22
}

export function nowInTimezone(tz) {
  return dayjs().tz(tz)
}

export function nowInMSK() {
  return nowInTimezone(timeConfig.moscowTimezone)
}

export function nowInAppTimezone(config) {
  return nowInTimezone(config.timezoneApp)
}

export function isInWorkWindow(window, tz = timeConfig.moscowTimezone) {
  const now = nowInTimezone(tz),
    today = now.startOf('day'),
    windowStart = today
      .hour(parseInt(window.start.split(':')[0]))
      .minute(parseInt(window.start.split(':')[1])),
    windowEnd = today
      .hour(parseInt(window.end.split(':')[0]))
      .minute(parseInt(window.end.split(':')[1]))

  if (windowStart.isAfter(windowEnd)) return now.isAfter(windowStart) || now.isBefore(windowEnd)

  return now.isAfter(windowStart) && now.isBefore(windowEnd)
}

export function isInSenderWorkWindow(config) {
  return isInWorkWindow(config.sender.window, config.sender.timezone)
}

export function getTimeUntilNextWindowOpen(window, tz = timeConfig.moscowTimezone) {
  const now = nowInTimezone(tz),
    today = now.startOf('day'),
    windowStart = today
      .hour(parseInt(window.start.split(':')[0]))
      .minute(parseInt(window.start.split(':')[1])),
    windowEnd = today
      .hour(parseInt(window.end.split(':')[0]))
      .minute(parseInt(window.end.split(':')[1]))

  let nextWindowStart

  if (windowStart.isAfter(windowEnd))
    nextWindowStart = now.isBefore(windowEnd) ? windowStart.add(1, 'day') : windowStart
  else {
    if (now.isBefore(windowStart)) nextWindowStart = windowStart
    else nextWindowStart = windowStart.add(1, 'day')
  }

  return Math.max(0, nextWindowStart.diff(now, 'millisecond'))
}

export function getTimeUntilSenderWindowOpen(config) {
  return getTimeUntilNextWindowOpen(config.sender.window, config.sender.timezone)
}

export function formatDateInMSK(date = nowInMSK()) {
  return date.format(timeConfig.dateFormat)
}

export function formatDateInTimezone(date, tz, format = timeConfig.dateFormat) {
  return date.tz(tz).format(format)
}

export function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function jitterDelay(minMs, maxMs) {
  return delay(randomDelay(minMs, maxMs))
}

export function getTimestamp() {
  return Date.now()
}

export function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000),
    minutes = Math.floor(seconds / 60),
    hours = Math.floor(minutes / 60)

  if (hours > 0) return `${hours}ч ${minutes % 60}м ${seconds % 60}с`
  if (minutes > 0) return `${minutes}м ${seconds % 60}с`
  return `${seconds}с`
}

export function getUptime(startTime) {
  return formatDuration(Date.now() - startTime)
}

export function isWeekend(date = nowInMSK()) {
  const weekday = date.day()
  return weekday === 6 || weekday === 0
}

export function isWorkday(date = nowInMSK()) {
  return !isWeekend(date)
}

export function getNextWorkday(from = nowInMSK()) {
  let nextDay = from.add(1, 'day')
  while (!isWorkday(nextDay)) nextDay = nextDay.add(1, 'day')
  return nextDay
}

export function getTimeUntilNextWorkday(from = nowInMSK()) {
  return getNextWorkday(from).diff(from, 'millisecond')
}

export function getTimeOfDayGreeting(date = nowInMSK()) {
  const hour = date.hour()

  if (hour >= greetingHours.morningStart && hour < greetingHours.morningEnd) return 'Доброе утро'
  if (hour >= greetingHours.morningEnd && hour < greetingHours.afternoonEnd) return 'Добрый день'
  return 'Добрый вечер'
}
