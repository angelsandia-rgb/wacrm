'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { IconCalendarEvent, IconChevronDown } from '@tabler/icons-react'
import { useAuth } from '@/hooks/use-auth'
import { useCan } from '@/hooks/use-can'
import { readResponseJson } from '@/lib/http/response-json'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  APPOINTMENT_STATUSES,
  APPOINTMENT_STATUS_LABEL_ES,
  APPOINTMENT_STATUS_TONE,
  CONFIRMATION_STATUS_LABEL_ES,
  isTerminalAppointmentStatus,
  type AppointmentStatus,
  type StatusTone,
} from '@/lib/clinic/appointment-status'
import {
  APPOINTMENT_RANGES,
  rangeBounds,
  type AppointmentRange,
} from '@/lib/clinic/time-range'
import { AppointmentDialog } from '@/components/clinic/appointment-dialog'
import { RescheduleDialog, type RescheduleTarget } from '@/components/clinic/reschedule-dialog'
import { VisitDialog, type VisitDraft } from '@/components/clinic/visit-dialog'

interface Row {
  id: string
  scheduled_at: string
  ends_at: string
  status: AppointmentStatus
  confirmation_status: keyof typeof CONFIRMATION_STATUS_LABEL_ES
  amount: number | string | null
  doctor_id: string
  service_id: string | null
  patient_id: string
  patient_profiles: { id: string; contacts: { name: string | null; phone: string | null } | null } | null
  doctor_profiles: { display_name: string; color: string | null } | null
  products: { name: string } | null
}

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'border-border text-muted-foreground',
  positive: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  negative: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400',
}

/** The one-click actions offered per current status. */
const ACTIONS: { to: AppointmentStatus; confirm?: 'confirmed' | 'declined' }[] = [
  { to: 'CONFIRMED', confirm: 'confirmed' },
  { to: 'COMPLETED' },
  { to: 'NO_SHOW' },
  { to: 'CANCELLED' },
]

// `useSearchParams` (the `?patient=<id>` deep link) requires a Suspense
// boundary or the production build bails out of prerendering this route.
export default function AppointmentsPage() {
  return (
    <Suspense fallback={null}>
      <AppointmentsPageInner />
    </Suspense>
  )
}

function AppointmentsPageInner() {
  const t = useTranslations('Clinic.appt')
  const { account } = useAuth()
  const canWrite = useCan('send-messages')
  const tz = account?.timezone || 'UTC'
  const searchParams = useSearchParams()
  const presetPatient = searchParams.get('patient')

  const [range, setRange] = useState<AppointmentRange>('week')
  const [doctorFilter, setDoctorFilter] = useState('')
  const [serviceFilter, setServiceFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [doctors, setDoctors] = useState<{ id: string; display_name: string }[]>([])
  const [services, setServices] = useState<{ id: string; name: string }[]>([])
  const [dialogOpen, setDialogOpen] = useState(false)
  const [reschedule, setReschedule] = useState<RescheduleTarget | null>(null)
  const [visitDraft, setVisitDraft] = useState<VisitDraft | null>(null)

  useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(h)
  }, [search])

  useEffect(() => {
    fetch('/api/doctors')
      .then((r) => readResponseJson<{ doctors: { id: string; display_name: string }[] }>(r))
      .then((b) => setDoctors(b.doctors ?? []))
      .catch(() => {})
    fetch('/api/products')
      .then((r) => readResponseJson<{ products: { id: string; name: string; is_active: boolean }[] }>(r))
      .then((b) => setServices((b.products ?? []).filter((p) => p.is_active)))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (presetPatient) setDialogOpen(true)
  }, [presetPatient])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { from, to } = rangeBounds(range, tz)
      const params = new URLSearchParams({ from, to })
      if (doctorFilter) params.set('doctor_id', doctorFilter)
      if (serviceFilter) params.set('service_id', serviceFilter)
      if (statusFilter) params.set('status', statusFilter)
      if (debounced) params.set('search', debounced)
      const res = await fetch(`/api/appointments?${params.toString()}`)
      const body = await readResponseJson<{ appointments: Row[] }>(res)
      setRows(res.ok ? body.appointments ?? [] : [])
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [range, tz, doctorFilter, serviceFilter, statusFilter, debounced])

  useEffect(() => {
    void load()
  }, [load])

  const fmtDate = useMemo(
    () => new Intl.DateTimeFormat('es-GT', { weekday: 'short', day: '2-digit', month: 'short', timeZone: tz }),
    [tz],
  )
  const fmtTime = useMemo(
    () => new Intl.DateTimeFormat('es-GT', { hour: '2-digit', minute: '2-digit', timeZone: tz }),
    [tz],
  )

  const act = async (row: Row, to: AppointmentStatus, confirm?: 'confirmed' | 'declined') => {
    const res = await fetch(`/api/appointments/${row.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: to, confirmation_status: confirm }),
    })
    if (!res.ok) {
      const b = await readResponseJson<{ error?: string }>(res)
      toast.error(b.error || t('actionError'))
      return
    }
    await load()
    // marking realizada → offer to register the visit right away
    if (to === 'COMPLETED') {
      setVisitDraft({
        patient_id: row.patient_id,
        appointment_id: row.id,
        doctor_id: row.doctor_id,
        service_id: row.service_id,
        amount: row.amount,
      })
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <IconCalendarEvent className="text-primary h-5 w-5" />
          <h1 className="text-foreground text-lg font-semibold">{t('title')}</h1>
        </div>
        {canWrite && (
          <Button onClick={() => setDialogOpen(true)}>{t('newTitle')}</Button>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {APPOINTMENT_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                'rounded-full border px-3 py-1 text-xs font-medium',
                range === r
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`range_${r}`)}
            </button>
          ))}
        </div>
        <select
          value={doctorFilter}
          onChange={(e) => setDoctorFilter(e.target.value)}
          className="border-border bg-background h-7 rounded-md border px-2 text-xs"
        >
          <option value="">{t('allDoctors')}</option>
          {doctors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.display_name}
            </option>
          ))}
        </select>
        <select
          value={serviceFilter}
          onChange={(e) => setServiceFilter(e.target.value)}
          className="border-border bg-background h-7 rounded-md border px-2 text-xs"
        >
          <option value="">{t('allServices')}</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border-border bg-background h-7 rounded-md border px-2 text-xs"
        >
          <option value="">{t('allStatuses')}</option>
          {APPOINTMENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {APPOINTMENT_STATUS_LABEL_ES[s]}
            </option>
          ))}
        </select>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('searchPatient')}
          className="h-7 max-w-[180px] text-xs"
        />
      </div>

      {loading ? (
        <div className="bg-muted/40 h-64 animate-pulse rounded-lg" />
      ) : rows.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-lg border border-dashed py-14 text-center text-sm">
          {t('empty')}
        </div>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colDate')}</TableHead>
                <TableHead>{t('colTime')}</TableHead>
                <TableHead>{t('colPatient')}</TableHead>
                <TableHead>{t('colDoctor')}</TableHead>
                <TableHead>{t('colService')}</TableHead>
                <TableHead>{t('colStatus')}</TableHead>
                <TableHead>{t('colConfirmation')}</TableHead>
                {canWrite && <TableHead className="text-right">{t('colActions')}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const c = r.patient_profiles?.contacts
                const terminal = isTerminalAppointmentStatus(r.status)
                return (
                  <TableRow key={r.id} className="hover:bg-muted/40">
                    <TableCell className="whitespace-nowrap capitalize">
                      {fmtDate.format(new Date(r.scheduled_at))}
                    </TableCell>
                    <TableCell className="tabular-nums">{fmtTime.format(new Date(r.scheduled_at))}</TableCell>
                    <TableCell>
                      <Link href={`/patients/${r.patient_id}`} className="text-foreground hover:underline">
                        {c?.name || '—'}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {r.doctor_profiles?.display_name || '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.products?.name || '—'}</TableCell>
                    <TableCell>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[APPOINTMENT_STATUS_TONE[r.status]]}`}
                      >
                        {APPOINTMENT_STATUS_LABEL_ES[r.status]}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {CONFIRMATION_STATUS_LABEL_ES[r.confirmation_status]}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        {!terminal && (
                          <DropdownMenu>
                            <DropdownMenuTrigger className="border-border text-foreground hover:bg-muted inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium">
                              {t('actions')}
                              <IconChevronDown className="size-3" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {ACTIONS.map((a) => (
                                <DropdownMenuItem key={a.to} onClick={() => act(r, a.to, a.confirm)}>
                                  {APPOINTMENT_STATUS_LABEL_ES[a.to]}
                                </DropdownMenuItem>
                              ))}
                              <DropdownMenuItem
                                onClick={() =>
                                  setReschedule({
                                    id: r.id,
                                    doctor_id: r.doctor_id,
                                    service_id: r.service_id,
                                    scheduled_at: r.scheduled_at,
                                    ends_at: r.ends_at,
                                  })
                                }
                              >
                                {t('reschedule')}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <AppointmentDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={load}
        presetPatientId={presetPatient}
      />
      <RescheduleDialog
        target={reschedule}
        onOpenChange={(v) => !v && setReschedule(null)}
        onDone={load}
      />
      <VisitDialog draft={visitDraft} onOpenChange={(v) => !v && setVisitDraft(null)} onSaved={load} />
    </div>
  )
}
