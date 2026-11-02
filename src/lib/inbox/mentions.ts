export interface MentionableMember {
  user_id: string
  full_name: string | null
  email: string | null
}

/** The handle a teammate is mentioned by: full name, else the email's local part. */
export function mentionLabel(m: MentionableMember): string {
  return (m.full_name?.trim() || m.email?.split('@')[0] || '').trim()
}

/** User ids mentioned as `@label` in the comment (case-insensitive). At
 *  each `@` the longest matching label wins, so `@Ana López` never also
 *  mentions a teammate called `Ana`. */
export function resolveMentions(body: string, members: MentionableMember[]): string[] {
  const text = body.toLowerCase()
  const labeled = members
    .map((m) => ({ id: m.user_id, label: mentionLabel(m).toLowerCase() }))
    .filter((m) => m.label)
    .sort((a, b) => b.label.length - a.label.length)
  const found = new Set<string>()
  for (let i = text.indexOf('@'); i >= 0; i = text.indexOf('@', i + 1)) {
    const hit = labeled.find((m) => {
      if (!text.startsWith(m.label, i + 1)) return false
      const next = text[i + 1 + m.label.length]
      return next === undefined || !/[\p{L}\p{N}_]/u.test(next)
    })
    if (hit) found.add(hit.id)
  }
  return members.map((m) => m.user_id).filter((id) => found.has(id))
}
