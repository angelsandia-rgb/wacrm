'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { IconUserHeart, IconSearch, IconAlertTriangle } from '@tabler/icons-react'
import { useAuth } from '@/hooks/use-auth'
import { readResponseJson } from '@/lib/http/response-json'
import { formatCurrency } from '@/lib/currency'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PATIENT_FILTERS, type PatientFilter, type PatientListRow } from '@/lib/clinic/patients'

interface ApiResult {
  rows: PatientListRow[]
  total: number
}

const FILTER_LABEL_KEY: Record<PatientFilter, string> = {
  all: 'filterAll',
  new: 'filterNew',
  returning: 'filterReturning',
  upcoming: 'filterUpcoming',
  no_future: 'filterNoFuture',
  follow_up_due: 'filterFollowUpDue',
}

export default function PatientsPage() {
  const t = useTranslations('Clinic.patients')
  const { account } = useAuth()
  const currency = account?.default_currency || 'GTQ'
  const tz = account?.timezone || undefined

  const [filter, setFilter] = useState<PatientFilter>('all')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<PatientListRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const reqId = useRef(0)

  useEffect(() => {
    const h = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(h)
  }, [search])

  const load = useCallback(async () => {
    const mine = ++reqId.current
    setLoading(true)
    setError(false)
    try {
      const params = new URLSearchParams({ filter })
      if (debounced) params.set('search', debounced)
      const res = await fetch(`/api/patients?${params.toString()}`)
      const data = await readResponseJson<ApiResult>(res)
      if (mine !== reqId.current) return
      if (!res.ok) {
        setError(true)
        setRows([])
      } else {
        setRows(data.rows ?? [])
      }
    } catch {
      if (mine === reqId.current) {
        setError(true)
        setRows([])
      }
    } finally {
      if (mine === reqId.current) setLoading(false)
    }
  }, [filter, debounced])

  useEffect(() => {
    void load()
  }, [load])

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat('es-GT', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz }),
    [tz],
  )
  const dateTimeFmt = useMemo(
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

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <IconUserHeart className="text-primary h-5 w-5" />
        <h1 className="text-foreground text-lg font-semibold">{t('title')}</h1>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:max-w-xs">
          <IconSearch className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            className="pl-8"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PATIENT_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
              filter === f
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {t(FILTER_LABEL_KEY[f])}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="bg-muted/40 h-64 animate-pulse rounded-lg" />
      ) : error ? (
        <div className="border-border text-muted-foreground flex flex-col items-center rounded-lg border border-dashed py-14 text-center text-sm">
          <IconAlertTriangle className="mb-2 h-6 w-6" />
          {t('loadError')}
        </div>
      ) : rows.length === 0 ? (
        <div className="border-border text-muted-foreground rounded-lg border border-dashed py-14 text-center text-sm">
          {filter === 'all' && !debounced ? t('empty') : t('emptyFiltered')}
        </div>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('colName')}</TableHead>
                <TableHead>{t('colPhone')}</TableHead>
                <TableHead>{t('colLastVisit')}</TableHead>
                <TableHead>{t('colNextAppt')}</TableHead>
                <TableHead className="text-right">{t('colVisits')}</TableHead>
                <TableHead className="text-right">{t('colValue')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id} className="hover:bg-muted/40">
                  <TableCell>
                    <Link href={`/patients/${r.id}`} className="text-foreground font-medium hover:underline">
                      {r.name || t('none')}
                    </Link>
                    {r.follow_up_due && (
                      <span className="ml-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                        {t('followUpBadge')}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">{r.phone || t('none')}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.last_visit_date ? dateFmt.format(new Date(`${r.last_visit_date}T12:00:00`)) : t('none')}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.next_appointment_at ? dateTimeFmt.format(new Date(r.next_appointment_at)) : t('none')}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.visit_count}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.total_value > 0 ? formatCurrency(r.total_value, currency) : t('none')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
