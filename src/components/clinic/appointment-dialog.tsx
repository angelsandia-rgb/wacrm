'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2, Search } from 'lucide-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import { cn } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RECURRENCE_FREQUENCIES } from '@/lib/clinic/types'
import { localMidnightUTC } from '@/lib/clinic/time-range'

interface Doctor {
  id: string
  display_name: string
  is_active: boolean
}
interface Service {
  id: string
  name: string
  price: number
  duration_minutes: number | null
  is_active: boolean
}
interface PatientOpt {
  id: string
  name: string | null
  phone: string | null
}

export function AppointmentDialog({
  open,
  onOpenChange,
  onCreated,
  presetPatientId,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
  presetPatientId?: string | null
}) {
  const t = useTranslations('Clinic.appt')
  const { account } = useAuth()
  const currency = account?.default_currency || 'GTQ'
  const tz = account?.timezone || 'UTC'

  const [doctors, setDoctors] = useState<Doctor[]>([])
  const [services, setServices] = useState<Service[]>([])
  const [doctorId, setDoctorId] = useState('')
  const [serviceId, setServiceId] = useState('')
  const [date, setDate] = useState('')
  const [slots, setSlots] = useState<{ start: string; end: string }[]>([])
  const [slotsLoading, setSlotsLoading] = useState(false)
  const [slot, setSlot] = useState('')

  const [patientQuery, setPatientQuery] = useState('')
  const [patientResults, setPatientResults] = useState<PatientOpt[]>([])
  const [patient, setPatient] = useState<PatientOpt | null>(null)

  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [needsConfirmation, setNeedsConfirmation] = useState(true)
  const [repeat, setRepeat] = useState(false)
  const [frequency, setFrequency] = useState<(typeof RECURRENCE_FREQUENCIES)[number]>('weekly')
  const [count, setCount] = useState('4')
  const [saving, setSaving] = useState(false)

  // reset on open
  useEffect(() => {
    if (!open) return
    setDoctorId('')
    setServiceId('')
    setDate('')
    setSlots([])
    setSlot('')
    setPatientQuery('')
    setPatientResults([])
    setPatient(null)
    setAmount('')
    setNotes('')
    setNeedsConfirmation(true)
    setRepeat(false)
    setCount('4')
    Promise.all([
      fetch('/api/doctors').then((r) => readResponseJson<{ doctors: Doctor[] }>(r)),
      fetch('/api/products').then((r) => readResponseJson<{ products: Service[] }>(r)),
    ])
      .then(([d, p]) => {
        setDoctors((d.doctors ?? []).filter((x) => x.is_active))
        setServices((p.products ?? []).filter((x) => x.is_active))
      })
      .catch(() => {})
    if (presetPatientId) {
      fetch(`/api/patients/${presetPatientId}`)
        .then((r) => readResponseJson<{ patient: { id: string; contacts: { name: string | null; phone: string | null } } }>(r))
        .then((b) => {
          if (b?.patient) setPatient({ id: b.patient.id, name: b.patient.contacts?.name ?? null, phone: b.patient.contacts?.phone ?? null })
        })
        .catch(() => {})
    }
  }, [open, presetPatientId])

  const service = useMemo(() => services.find((s) => s.id === serviceId) ?? null, [services, serviceId])

  useEffect(() => {
    if (service) setAmount(String(service.price ?? ''))
  }, [service])

  // load slots when doctor + date set
  const loadSlots = useCallback(async () => {
    if (!doctorId || !date) {
      setSlots([])
      return
    }
    setSlotsLoading(true)
    setSlot('')
    try {
      const [y, m, d] = date.split('-').map(Number)
      const from = localMidnightUTC(y, m, d, tz).toISOString()
      const to = localMidnightUTC(y, m, d + 1, tz).toISOString()
      const params = new URLSearchParams({ doctor_id: doctorId, from, to })
      if (serviceId) params.set('service_id', serviceId)
      const res = await fetch(`/api/appointments/slots?${params.toString()}`)
      const body = await readResponseJson<{ slots: { start: string; end: string }[] }>(res)
      setSlots(res.ok ? body.slots ?? [] : [])
    } catch {
      setSlots([])
    } finally {
      setSlotsLoading(false)
    }
  }, [doctorId, date, serviceId, tz])

  useEffect(() => {
    void loadSlots()
  }, [loadSlots])

  // patient search
  useEffect(() => {
    const q = patientQuery.trim()
    if (q.length < 2) {
      setPatientResults([])
      return
    }
    const h = setTimeout(() => {
      fetch(`/api/patients?search=${encodeURIComponent(q)}&limit=8`)
        .then((r) => readResponseJson<{ rows: { id: string; name: string | null; phone: string | null }[] }>(r))
        .then((b) => setPatientResults(b.rows ?? []))
        .catch(() => setPatientResults([]))
    }, 250)
    return () => clearTimeout(h)
  }, [patientQuery])

  const slotFmt = useMemo(
    () => new Intl.DateTimeFormat('es-GT', { hour: '2-digit', minute: '2-digit', timeZone: tz }),
    [tz],
  )

  const canSubmit = doctorId && patient && slot && !saving

  const submit = async () => {
    if (!canSubmit || !patient) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        patient_id: patient.id,
        doctor_id: doctorId,
        service_id: serviceId || null,
        scheduled_at: slot,
        amount: amount.trim() === '' ? null : Number(amount),
        notes: notes.trim() || null,
        needs_confirmation: needsConfirmation,
      }
      if (repeat) {
        body.recurrence = { frequency, count: Number(count) }
      }
      const res = await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await readResponseJson<{ error?: string }>(res)
      if (!res.ok) throw new Error(data.error)
      toast.success(t('created'))
      onOpenChange(false)
      onCreated()
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : t('createError'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('newTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-xs">{t('doctor')}</span>
              <select
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="border-border bg-background h-8 w-full rounded-md border px-2 text-sm"
              >
                <option value="">—</option>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.display_name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-xs">{t('service')}</span>
              <select
                value={serviceId}
                onChange={(e) => setServiceId(e.target.value)}
                className="border-border bg-background h-8 w-full rounded-md border px-2 text-sm"
              >
                <option value="">—</option>
                {services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.duration_minutes ? ` · ${s.duration_minutes}m` : ''}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div>
            <Label className="text-muted-foreground text-xs">{t('date')}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1" />
          </div>

          {doctorId && date && (
            <div>
              <span className="text-muted-foreground mb-1 block text-xs">{t('slot')}</span>
              {slotsLoading ? (
                <div className="bg-muted/40 h-10 animate-pulse rounded" />
              ) : slots.length === 0 ? (
                <p className="text-muted-foreground text-xs">{t('noSlots')}</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((s) => (
                    <button
                      key={s.start}
                      type="button"
                      onClick={() => setSlot(s.start)}
                      className={cn(
                        'rounded-md border px-2 py-1 text-xs',
                        slot === s.start
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-foreground hover:bg-muted',
                      )}
                    >
                      {slotFmt.format(new Date(s.start))}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div>
            <span className="text-muted-foreground mb-1 block text-xs">{t('patient')}</span>
            {patient ? (
              <div className="border-border flex items-center justify-between rounded-md border px-2.5 py-1.5 text-sm">
                <span className="text-foreground">
                  {patient.name || '—'} {patient.phone ? <span className="text-muted-foreground">· {patient.phone}</span> : null}
                </span>
                <button type="button" onClick={() => setPatient(null)} className="text-muted-foreground hover:text-foreground text-xs">
                  {t('change')}
                </button>
              </div>
            ) : (
              <div className="relative">
                <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
                <Input
                  value={patientQuery}
                  onChange={(e) => setPatientQuery(e.target.value)}
                  placeholder={t('patientSearch')}
                  className="pl-8"
                />
                {patientResults.length > 0 && (
                  <ul className="border-border bg-popover absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-md border shadow-md">
                    {patientResults.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPatient(p)
                            setPatientResults([])
                            setPatientQuery('')
                          }}
                          className="hover:bg-muted block w-full px-2.5 py-1.5 text-left text-sm"
                        >
                          {p.name || '—'} <span className="text-muted-foreground">· {p.phone}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-muted-foreground mb-1 block text-xs">{t('amount')}</span>
              <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
              {service && (
                <span className="text-muted-foreground mt-0.5 block text-[11px]">
                  {t('suggested')}: {formatCurrency(service.price, currency)}
                </span>
              )}
            </label>
            <label className="mt-5 flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={needsConfirmation}
                onChange={(e) => setNeedsConfirmation(e.target.checked)}
              />
              <span className="text-muted-foreground">{t('needsConfirmation')}</span>
            </label>
          </div>

          <label className="block">
            <span className="text-muted-foreground mb-1 block text-xs">{t('notes')}</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="border-border bg-background w-full rounded-md border px-2 py-1 text-sm"
            />
          </label>

          <div className="border-border rounded-md border p-2.5">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} />
              <span className="text-foreground font-medium">{t('repeat')}</span>
            </label>
            {repeat && (
              <div className="mt-2 flex items-center gap-2">
                <select
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as (typeof RECURRENCE_FREQUENCIES)[number])}
                  className="border-border bg-background h-7 rounded-md border px-1.5 text-xs"
                >
                  {RECURRENCE_FREQUENCIES.map((f) => (
                    <option key={f} value={f}>
                      {t(`freq_${f}`)}
                    </option>
                  ))}
                </select>
                <Input
                  type="number"
                  min={2}
                  max={26}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  className="h-7 w-16 text-xs"
                />
                <span className="text-muted-foreground text-xs">{t('sessions')}</span>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
