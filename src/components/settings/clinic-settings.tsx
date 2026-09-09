'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  Loader2,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Stethoscope,
} from 'lucide-react'
import { useCan } from '@/hooks/use-can'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DAY_LABELS_ES } from '@/lib/clinic/doctors'

interface Doctor {
  id: string
  display_name: string
  specialty: string | null
  color: string | null
  is_active: boolean
  restrict_to_own: boolean
  user_id: string | null
}
interface AvailabilityRow {
  id: string
  doctor_id: string
  day_of_week: number
  start_time: string
  end_time: string
}
interface TimeOffRow {
  id: string
  doctor_id: string
  starts_at: string
  ends_at: string
  reason: string | null
  is_extra_hours: boolean
}
interface ApiResult {
  doctors: Doctor[]
  availability: AvailabilityRow[]
  timeOff: TimeOffRow[]
}

const DEFAULT_COLOR = '#3b82f6'

export function ClinicSettings() {
  const t = useTranslations('Clinic.settings')
  const canEdit = useCan('edit-settings')
  const { account } = useAuth()
  const tz = account?.timezone || undefined

  const [data, setData] = useState<ApiResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newSpecialty, setNewSpecialty] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/doctors')
      const body = await readResponseJson<ApiResult>(res)
      if (res.ok) setData(body)
      else toast.error(t('loadError'))
    } catch {
      toast.error(t('loadError'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const addDoctor = async () => {
    const name = newName.trim()
    if (name.length < 2) return
    setCreating(true)
    try {
      const res = await fetch('/api/doctors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          display_name: name,
          specialty: newSpecialty.trim() || null,
          color: DEFAULT_COLOR,
        }),
      })
      const body = await readResponseJson<{ doctor?: Doctor; error?: string }>(res)
      if (!res.ok || !body.doctor) throw new Error(body.error)
      setNewName('')
      setNewSpecialty('')
      await load()
      setExpanded(body.doctor.id)
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('saveError'))
    } finally {
      setCreating(false)
    }
  }

  const patchDoctor = async (id: string, patch: Partial<Doctor>) => {
    const res = await fetch(`/api/doctors/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) {
      const body = await readResponseJson<{ error?: string }>(res)
      toast.error(body.error || t('saveError'))
      return
    }
    await load()
  }

  const deleteDoctor = async (id: string) => {
    const res = await fetch(`/api/doctors/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await readResponseJson<{ error?: string }>(res)
      toast.error(body.error || t('saveError'))
      return
    }
    if (expanded === id) setExpanded(null)
    await load()
  }

  const doctors = data?.doctors ?? []

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-foreground flex items-center gap-2 text-lg font-semibold">
          <Stethoscope className="text-primary size-5" />
          {t('title')}
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">{t('desc')}</p>
      </header>

      {loading ? (
        <div className="bg-muted/40 h-40 animate-pulse rounded-lg" />
      ) : (
        <div className="space-y-3">
          {doctors.length === 0 && (
            <p className="text-muted-foreground text-sm">{t('empty')}</p>
          )}

          {doctors.map((d) => (
            <DoctorRow
              key={d.id}
              doctor={d}
              availability={(data?.availability ?? []).filter((a) => a.doctor_id === d.id)}
              timeOff={(data?.timeOff ?? []).filter((to) => to.doctor_id === d.id)}
              open={expanded === d.id}
              onToggle={() => setExpanded(expanded === d.id ? null : d.id)}
              canEdit={canEdit}
              tz={tz}
              onPatch={(patch) => patchDoctor(d.id, patch)}
              onDelete={() => deleteDoctor(d.id)}
              onReload={load}
            />
          ))}

          {canEdit && (
            <div className="border-border bg-card mt-4 rounded-lg border p-4">
              <p className="text-foreground mb-2 text-sm font-medium">{t('addTitle')}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={t('namePlaceholder')}
                  className="sm:max-w-[220px]"
                />
                <Input
                  value={newSpecialty}
                  onChange={(e) => setNewSpecialty(e.target.value)}
                  placeholder={t('specialtyPlaceholder')}
                  className="sm:max-w-[220px]"
                />
                <Button onClick={addDoctor} disabled={creating || newName.trim().length < 2}>
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  {t('addBtn')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <NoteTemplatesManager />
    </div>
  )
}

function DoctorRow({
  doctor,
  availability,
  timeOff,
  open,
  onToggle,
  canEdit,
  tz,
  onPatch,
  onDelete,
  onReload,
}: {
  doctor: Doctor
  availability: AvailabilityRow[]
  timeOff: TimeOffRow[]
  open: boolean
  onToggle: () => void
  canEdit: boolean
  tz?: string
  onPatch: (patch: Partial<Doctor>) => void
  onDelete: () => void
  onReload: () => Promise<void>
}) {
  const t = useTranslations('Clinic.settings')

  return (
    <div className="border-border bg-card rounded-lg border">
      <div className="flex items-center gap-3 px-4 py-3">
        <button type="button" onClick={onToggle} className="text-muted-foreground hover:text-foreground">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ background: doctor.color || DEFAULT_COLOR }}
        />
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', doctor.is_active ? 'text-foreground' : 'text-muted-foreground line-through')}>
            {doctor.display_name}
          </p>
          {doctor.specialty && <p className="text-muted-foreground truncate text-xs">{doctor.specialty}</p>}
        </div>
        {canEdit && (
          <>
            <label className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={doctor.is_active}
                onChange={(e) => onPatch({ is_active: e.target.checked })}
              />
              {t('active')}
            </label>
            <button
              type="button"
              onClick={onDelete}
              title={t('delete')}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
            </button>
          </>
        )}
      </div>

      {open && (
        <div className="border-border space-y-5 border-t p-4">
          {canEdit && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('name')}>
                <Input
                  defaultValue={doctor.display_name}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== doctor.display_name) onPatch({ display_name: v })
                  }}
                />
              </Field>
              <Field label={t('specialty')}>
                <Input
                  defaultValue={doctor.specialty ?? ''}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v !== (doctor.specialty ?? '')) onPatch({ specialty: v || null })
                  }}
                />
              </Field>
              <Field label={t('color')}>
                <input
                  type="color"
                  defaultValue={doctor.color || DEFAULT_COLOR}
                  onBlur={(e) => {
                    if (e.target.value !== doctor.color) onPatch({ color: e.target.value })
                  }}
                  className="border-border h-8 w-16 rounded border"
                />
              </Field>
              <Field label={t('restrictToOwn')}>
                <label className="text-muted-foreground flex h-8 items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={doctor.restrict_to_own}
                    onChange={(e) => onPatch({ restrict_to_own: e.target.checked })}
                  />
                  {t('restrictHint')}
                </label>
              </Field>
            </div>
          )}

          <WeeklyEditor
            doctorId={doctor.id}
            initial={availability}
            canEdit={canEdit}
            onSaved={onReload}
          />
          <TimeOffEditor
            doctorId={doctor.id}
            entries={timeOff}
            canEdit={canEdit}
            tz={tz}
            onChanged={onReload}
          />
        </div>
      )}
    </div>
  )
}

interface Slot {
  start: string
  end: string
}

function WeeklyEditor({
  doctorId,
  initial,
  canEdit,
  onSaved,
}: {
  doctorId: string
  initial: AvailabilityRow[]
  canEdit: boolean
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('Clinic.schedule')
  const toGrid = useCallback((rows: AvailabilityRow[]) => {
    const g: Record<number, Slot[]> = {}
    for (const d of DAY_LABELS_ES) g[d.value] = []
    for (const r of rows) {
      ;(g[r.day_of_week] ??= []).push({ start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) })
    }
    for (const k of Object.keys(g)) g[Number(k)].sort((a, b) => a.start.localeCompare(b.start))
    return g
  }, [])

  const [grid, setGrid] = useState<Record<number, Slot[]>>(() => toGrid(initial))
  const [saving, setSaving] = useState(false)
  const original = useMemo(() => JSON.stringify(toGrid(initial)), [initial, toGrid])
  const dirty = JSON.stringify(grid) !== original

  const setDay = (day: number, slots: Slot[]) => setGrid((g) => ({ ...g, [day]: slots }))

  const save = async () => {
    setSaving(true)
    try {
      const blocks = Object.entries(grid).flatMap(([day, slots]) =>
        slots.map((s) => ({ day_of_week: Number(day), start_time: s.start, end_time: s.end })),
      )
      const res = await fetch(`/api/doctors/${doctorId}/availability`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blocks }),
      })
      const body = await readResponseJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(body.error)
      await onSaved()
      toast.success(t('saved'))
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('saveError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-foreground mb-2 text-sm font-medium">{t('title')}</p>
      <div className="space-y-1.5">
        {DAY_LABELS_ES.map((d) => (
          <div key={d.value} className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">{d.label}</span>
            {(grid[d.value] ?? []).map((slot, i) => (
              <span key={i} className="flex items-center gap-1">
                <input
                  type="time"
                  value={slot.start}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setDay(
                      d.value,
                      grid[d.value].map((s, j) => (j === i ? { ...s, start: e.target.value } : s)),
                    )
                  }
                  className="border-border h-7 rounded border px-1 text-xs"
                />
                <span className="text-muted-foreground text-xs">–</span>
                <input
                  type="time"
                  value={slot.end}
                  disabled={!canEdit}
                  onChange={(e) =>
                    setDay(
                      d.value,
                      grid[d.value].map((s, j) => (j === i ? { ...s, end: e.target.value } : s)),
                    )
                  }
                  className="border-border h-7 rounded border px-1 text-xs"
                />
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setDay(d.value, grid[d.value].filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <button
                type="button"
                onClick={() => setDay(d.value, [...(grid[d.value] ?? []), { start: '08:00', end: '13:00' }])}
                className="text-primary text-xs hover:underline"
              >
                {t('addBlock')}
              </button>
            )}
          </div>
        ))}
      </div>
      {canEdit && dirty && (
        <Button size="sm" className="mt-3" onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {t('save')}
        </Button>
      )}
    </div>
  )
}

function TimeOffEditor({
  doctorId,
  entries,
  canEdit,
  tz,
  onChanged,
}: {
  doctorId: string
  entries: TimeOffRow[]
  canEdit: boolean
  tz?: string
  onChanged: () => Promise<void>
}) {
  const t = useTranslations('Clinic.schedule')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [reason, setReason] = useState('')
  const [extra, setExtra] = useState(false)
  const [busy, setBusy] = useState(false)

  const fmt = useMemo(
    () =>
      new Intl.DateTimeFormat('es-GT', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: tz,
      }),
    [tz],
  )

  const add = async () => {
    if (!start || !end) return
    setBusy(true)
    try {
      const res = await fetch(`/api/doctors/${doctorId}/time-off`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          starts_at: new Date(start).toISOString(),
          ends_at: new Date(end).toISOString(),
          reason: reason.trim() || null,
          is_extra_hours: extra,
        }),
      })
      const body = await readResponseJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(body.error)
      setStart('')
      setEnd('')
      setReason('')
      setExtra(false)
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (entryId: string) => {
    const res = await fetch(`/api/doctors/${doctorId}/time-off?entry=${entryId}`, { method: 'DELETE' })
    if (res.ok) await onChanged()
  }

  return (
    <div>
      <p className="text-foreground mb-2 text-sm font-medium">{t('timeOffTitle')}</p>
      {entries.length === 0 ? (
        <p className="text-muted-foreground text-xs">{t('timeOffEmpty')}</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-foreground">
                {fmt.format(new Date(e.starts_at))} → {fmt.format(new Date(e.ends_at))}
                {e.is_extra_hours ? ` · ${t('extraHours')}` : ''}
                {e.reason ? ` · ${e.reason}` : ''}
              </span>
              {canEdit && (
                <button type="button" onClick={() => remove(e.id)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="size-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canEdit && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="border-border h-7 rounded border px-1 text-xs"
          />
          <input
            type="datetime-local"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="border-border h-7 rounded border px-1 text-xs"
          />
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('reasonPlaceholder')}
            className="h-7 max-w-[160px] text-xs"
          />
          <label className="text-muted-foreground flex items-center gap-1 text-xs">
            <input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} />
            {t('extraHours')}
          </label>
          <Button size="xs" variant="outline" onClick={add} disabled={busy || !start || !end}>
            {busy ? <Loader2 className="size-3 animate-spin" /> : <Plus className="size-3" />}
            {t('addTimeOff')}
          </Button>
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 block text-xs">{label}</span>
      {children}
    </label>
  )
}

interface NoteTemplate {
  id: string
  name: string
  body: string
}

export function NoteTemplatesManager() {
  const t = useTranslations('Clinic.noteTemplates')
  const canEdit = useCan('send-messages')
  const [templates, setTemplates] = useState<NoteTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/note-templates')
      const b = await readResponseJson<{ templates: NoteTemplate[] }>(res)
      setTemplates(res.ok ? b.templates ?? [] : [])
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (name.trim().length < 2) return
    setBusy(true)
    try {
      const res = await fetch('/api/note-templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), body }),
      })
      if (!res.ok) {
        const e = await readResponseJson<{ error?: string }>(res)
        throw new Error(e.error)
      }
      setName('')
      setBody('')
      await load()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('saveError'))
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async (id: string, patch: Partial<NoteTemplate>) => {
    const res = await fetch(`/api/note-templates/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (res.ok) {
      setEditing(null)
      await load()
    } else toast.error(t('saveError'))
  }

  const remove = async (id: string) => {
    const res = await fetch(`/api/note-templates/${id}`, { method: 'DELETE' })
    if (res.ok) await load()
  }

  return (
    <div className="border-border mt-8 border-t pt-6">
      <h3 className="text-foreground text-sm font-semibold">{t('title')}</h3>
      <p className="text-muted-foreground mt-1 text-sm">{t('desc')}</p>

      {loading ? (
        <div className="bg-muted/40 mt-3 h-20 animate-pulse rounded" />
      ) : (
        <ul className="mt-3 space-y-2">
          {templates.map((tpl) => (
            <li key={tpl.id} className="border-border bg-card rounded-lg border p-3">
              {editing === tpl.id ? (
                <EditTemplate tpl={tpl} onSave={(p) => saveEdit(tpl.id, p)} onCancel={() => setEditing(null)} />
              ) : (
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-foreground text-sm font-medium">{tpl.name}</span>
                    {canEdit && (
                      <span className="flex items-center gap-2">
                        <button onClick={() => setEditing(tpl.id)} className="text-primary text-xs hover:underline">
                          {t('edit')}
                        </button>
                        <button
                          onClick={() => remove(tpl.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                  {tpl.body && (
                    <p className="text-muted-foreground mt-1 line-clamp-3 whitespace-pre-wrap text-xs">{tpl.body}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="border-border bg-card mt-3 space-y-2 rounded-lg border p-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={4}
            placeholder={t('bodyPlaceholder')}
            className="border-border bg-background w-full rounded-md border px-2 py-1 text-sm"
          />
          <Button size="sm" onClick={add} disabled={busy || name.trim().length < 2}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            {t('addBtn')}
          </Button>
        </div>
      )}
    </div>
  )
}

function EditTemplate({
  tpl,
  onSave,
  onCancel,
}: {
  tpl: NoteTemplate
  onSave: (p: Partial<NoteTemplate>) => void
  onCancel: () => void
}) {
  const t = useTranslations('Clinic.noteTemplates')
  const [name, setName] = useState(tpl.name)
  const [body, setBody] = useState(tpl.body)
  return (
    <div className="space-y-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        className="border-border bg-background w-full rounded-md border px-2 py-1 text-sm"
      />
      <div className="flex gap-2">
        <Button size="xs" onClick={() => onSave({ name: name.trim(), body })} disabled={name.trim().length < 2}>
          {t('save')}
        </Button>
        <Button size="xs" variant="outline" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  )
}
