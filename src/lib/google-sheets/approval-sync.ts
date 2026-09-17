// ============================================================
// Reservation approval sync — the DB side of /api/google-sheets/
// reservations-approval-sync/cron. Reads the hotel-filled "Aprobación"
// column back OUT of Google Sheets and applies it to
// `reservation_requests.status`, the other direction from
// `dispatch.ts`'s writeReservationRow (CRM → Sheets).
//
// One-directional-per-row and conservative on purpose: only a PENDING
// reservation with a known `sheet_row` is checked, and only a
// recognized "Aprobado"/"Negado" (or a close alias) actually moves it —
// a blank cell or unrelated text is left alone, so a hotel using the
// Sheet only for reference (or clearing a cell by accident) can never
// silently reopen or deny something already decided elsewhere.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { getValidAccessToken } from './oauth'
import { getValues } from './api'
import { RESERVATION_TAB_LABEL, cat } from './row-builder'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

const MAX_ACCOUNTS = 200
const MAX_RESERVATIONS_PER_ACCOUNT = 500
const APPROVED_HEADER = 'Aprobación'

const APPROVED_ALIASES = new Set(['aprobado', 'aprobada', 'aprobar', 'sí', 'si', 'yes', 'approved'])
const DENIED_ALIASES = new Set(['negado', 'negada', 'rechazado', 'rechazada', 'rechazar', 'denied', 'no'])

export function matchApproval(cell: unknown): 'approved' | 'denied' | null {
  if (typeof cell !== 'string') return null
  const v = cell.trim().toLowerCase()
  if (!v) return null
  if (APPROVED_ALIASES.has(v)) return 'approved'
  if (DENIED_ALIASES.has(v)) return 'denied'
  return null
}

/** 0-based column index → A1 letter(s) (0 → A, 25 → Z, 26 → AA, ...). */
export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export interface ApprovalSyncResult {
  accounts: number
  checked: number
  updated: number
  failed: number
}

interface ConfigRow {
  account_id: string
  spreadsheet_id: string | null
  sheet_tab: string
  status: string
}

interface PendingRow {
  id: string
  category: string
  sheet_row: number
}

export async function syncReservationApprovals(
  admin: SupabaseClient,
): Promise<ApprovalSyncResult> {
  const res: ApprovalSyncResult = { accounts: 0, checked: 0, updated: 0, failed: 0 }

  // Only hotel accounts have reservation_requests at all; joining through
  // accounts keeps this from wasting a Sheets round-trip on every other
  // connected account (deals/quotes/leads-only Sheets setups).
  const { data: configs, error } = await admin
    .from('google_sheets_config')
    .select('account_id, spreadsheet_id, sheet_tab, status, accounts!inner(industry_vertical)')
    .eq('status', 'connected')
    .eq('accounts.industry_vertical', 'hotel')
    .not('spreadsheet_id', 'is', null)
    .limit(MAX_ACCOUNTS)
  if (error) throw new Error(`reservation approval sync: config scan failed: ${error.message}`)
  if (!configs?.length) return res

  for (const cfg of configs as unknown as ConfigRow[]) {
    res.accounts++
    try {
      await syncAccount(admin, cfg, res)
    } catch (err) {
      res.failed++
      console.error(
        '[google-sheets] approval sync failed for account',
        cfg.account_id,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return res
}

async function syncAccount(
  admin: SupabaseClient,
  cfg: ConfigRow,
  res: ApprovalSyncResult,
): Promise<void> {
  const { data: pending, error: pErr } = await admin
    .from('reservation_requests')
    .select('id, category, sheet_row')
    .eq('account_id', cfg.account_id)
    .eq('status', 'pending')
    .not('sheet_row', 'is', null)
    .limit(MAX_RESERVATIONS_PER_ACCOUNT)
  if (pErr) throw new Error(`reservation scan failed: ${pErr.message}`)
  if (!pending?.length) return

  const byCategory = new Map<string, PendingRow[]>()
  for (const r of pending as unknown as PendingRow[]) {
    const list = byCategory.get(r.category)
    if (list) list.push(r)
    else byCategory.set(r.category, [r])
  }

  const token = await getValidAccessToken(admin, cfg.account_id)
  const spreadsheetId = cfg.spreadsheet_id!

  for (const [category, rows] of byCategory) {
    const tabLabel = RESERVATION_TAB_LABEL[category]
    if (!tabLabel) continue
    const tab = cat(cfg.sheet_tab, tabLabel)

    let header: (string | number | null)[][]
    try {
      header = await getValues(token, spreadsheetId, `${tab}!1:1`)
    } catch (err) {
      console.error('[google-sheets] approval sync header read failed', cfg.account_id, tab, err)
      continue
    }
    const aprobIdx = (header[0] ?? []).findIndex((h) => String(h ?? '').trim() === APPROVED_HEADER)
    if (aprobIdx === -1) continue
    const col = columnLetter(aprobIdx)

    const minRow = Math.min(...rows.map((r) => r.sheet_row))
    const maxRow = Math.max(...rows.map((r) => r.sheet_row))

    let colValues: (string | number | null)[][]
    try {
      colValues = await getValues(token, spreadsheetId, `${tab}!${col}${minRow}:${col}${maxRow}`)
    } catch (err) {
      console.error('[google-sheets] approval sync column read failed', cfg.account_id, tab, err)
      continue
    }

    for (const r of rows) {
      res.checked++
      const cell = colValues[r.sheet_row - minRow]?.[0]
      const matched = matchApproval(cell)
      if (!matched) continue

      // `.eq('status', 'pending')` + checking the returned row (not just
      // `error`) guards against a race with a CRM-side decision landing
      // first: if the status already moved, this matches zero rows and
      // Supabase reports that as success with an empty array, not an
      // error — without the length check the sheet's (now stale) value
      // would still fire a dispatch and overwrite the newer CRM decision.
      const { data: updRows, error: updErr } = await admin
        .from('reservation_requests')
        .update({ status: matched })
        .eq('id', r.id)
        .eq('account_id', cfg.account_id)
        .eq('status', 'pending')
        .select('id')
      if (updErr) {
        res.failed++
        console.error('[google-sheets] approval sync status update failed', r.id, updErr.message)
        continue
      }
      if (!updRows || updRows.length === 0) continue
      res.updated++

      // Fires the same "explicit status change" path the CRM buttons use
      // — writes the canonical label back (normalizes e.g. "sí" →
      // "Aprobado") and lets every other `reservation.updated` consumer
      // (contact custom fields, webhooks) see the decision.
      await dispatchWebhookEvent(admin, cfg.account_id, 'reservation.updated', {
        reservation_id: r.id,
        source: 'manual',
        status_changed: true,
      })
    }
  }
}
