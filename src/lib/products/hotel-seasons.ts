/** Monday-Sunday inclusive calendar week; rate ranges apply to occupied nights. */
export function fullCalendarWeek(iso: string): { from: string; to: string } {
  const date = new Date(`${iso}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new Error('Invalid calendar date')
  const monday = new Date(date)
  monday.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) }
}

/** Gregorian computus. Holy Week is Monday through Easter Sunday. */
export function easterSunday(year: number): string {
  if (!Number.isInteger(year) || year < 1583 || year > 4099) throw new Error('Unsupported Gregorian year')
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = (h + l - 7 * m + 114) % 31 + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function holyWeek(year: number) { return fullCalendarWeek(easterSunday(year)) }
export function yearEndWeeks(year: number) {
  return { from: fullCalendarWeek(`${year}-12-25`).from, to: fullCalendarWeek(`${year + 1}-01-01`).to }
}
