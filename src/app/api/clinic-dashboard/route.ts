import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/clinic/auth'
import { loadClinicDashboard } from '@/lib/clinic-metrics/queries'

const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000

/**
 * GET /api/clinic-dashboard?from=<ISO>&to=<ISO>
 *
 * Every number the clinic Panel + KPIs show, computed server-side (spec
 * §24). RLS-scoped — a restricted doctor-user's figures already only
 * cover their own appointments / visits.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const url = new URL(request.url)
    const now = Date.now()
    const from = url.searchParams.get('from')
      ? new Date(url.searchParams.get('from')!)
      : new Date(now - 30 * 24 * 60 * 60 * 1000)
    let to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date(now)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      return NextResponse.json({ error: 'Rango inválido' }, { status: 400 })
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      to = new Date(from.getTime() + MAX_RANGE_MS)
    }

    const { data: acct, error: accountError } = await supabase
      .from('accounts')
      .select('timezone, default_currency')
      .eq('id', accountId)
      .maybeSingle()
    if (accountError) throw accountError

    const stats = await loadClinicDashboard(supabase, accountId, {
      from: from.toISOString(),
      to: to.toISOString(),
      currency: (acct?.default_currency as string | null) || 'GTQ',
      timezone: (acct?.timezone as string | null) || 'UTC',
    })
    return NextResponse.json(stats)
  } catch (err) {
    return toErrorResponse(err)
  }
}
