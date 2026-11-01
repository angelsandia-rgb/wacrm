/** Run with `npx tsx scripts/configure-vsr-attention-pipeline.ts [--apply]`.
 * Account-scoped, idempotent configuration; backs up before any mutation.
 * Does not send messages, cancel reservations or discard silent prospects. */
import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { syncHotelReservationDeal } from '../src/lib/pipelines/sync-hotel-reservation'

const accountId = '09cd99b6-db6e-4644-a76b-01b11f7364f7'
const anaId = '83ebe90f-4593-4f78-bb22-cdfb8f79e341'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
const apply = process.argv.includes('--apply')
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guatemala', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
async function main() {
  const read = async (query: PromiseLike<{ data: unknown; error: unknown }>) => { const r = await query; if (r.error) throw r.error; return r.data }
  const [account, profiles, pipelines, stages, configs, deals, requests] = await Promise.all([
    read(db.from('accounts').select('id,name,industry_vertical,timezone,feature_flags').eq('id', accountId).single()),
    read(db.from('profiles').select('user_id,full_name,account_role').eq('account_id', accountId)),
    read(db.from('pipelines').select('*').eq('account_id', accountId)),
    read(db.from('pipeline_stages').select('*,pipelines!inner(account_id)').eq('pipelines.account_id', accountId)),
    read(db.from('ai_configs').select('id,handoff_agent_id').eq('account_id', accountId)),
    read(db.from('deals').select('*').eq('account_id', accountId)),
    read(db.from('reservation_requests').select('id,status,check_in,use_date,is_active_build,guest_confirmed_at').eq('account_id', accountId)),
  ]) as [Record<string, unknown>, { user_id: string; account_role: string }[], { id: string; name: string }[], { id: string; pipeline_id: string; name: string; position: number }[], { id: string; handoff_agent_id: string | null }[], unknown[], { id: string; check_in: string | null; use_date: string | null; is_active_build: boolean; status: string }[]]
  if (account.industry_vertical !== 'hotel' || !profiles.some(p => p.user_id === anaId && ['admin', 'owner', 'agent'].includes(p.account_role))) throw new Error('Hotel or Ana membership does not match')
  if (pipelines.length !== 5 || configs.length !== 1) throw new Error('Unexpected pipeline/configuration count; review before proceeding')
  const rename: Record<string, string> = { 'Conversación': 'Cotizando', 'Esperando confirmación': 'Pendiente de confirmación', 'Confirmado': 'Visita confirmada' }
  const eligible = requests.filter(r => r.is_active_build && (r.check_in || r.use_date || '') >= today)
  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', account: account.name, recipient: anaId, pipelines: pipelines.map(p => p.name), renames: rename, newStage: 'Descarte', futureActiveRequests: eligible.length, existingDealsPreserved: deals.length }, null, 2))
  if (!apply) return
  mkdirSync('outputs', { recursive: true })
  const backup = `outputs/vsr-attention-pipeline-backup-${Date.now()}.json`
  writeFileSync(backup, JSON.stringify({ account, profiles, pipelines, stages, configs, deals, requests }, null, 2))
  console.log('Backup:', backup)
  for (const stage of stages) {
    if (!rename[stage.name]) continue
    const { error } = await db.from('pipeline_stages').update({ name: rename[stage.name] }).eq('id', stage.id).eq('pipeline_id', stage.pipeline_id).eq('name', stage.name)
    if (error) throw error
  }
  for (const pipeline of pipelines) {
    if (stages.some(s => s.pipeline_id === pipeline.id && s.name === 'Descarte')) continue
    const h = createHash('sha256').update(`vsr-discard:${pipeline.id}`).digest('hex')
    const id = `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`
    const { error } = await db.from('pipeline_stages').upsert({ id, pipeline_id: pipeline.id, name: 'Descarte', position: 4, color: '#64748b', is_won: false }, { onConflict: 'id', ignoreDuplicates: true })
    if (error) throw error
  }
  const { error } = await db.from('ai_configs').update({ handoff_agent_id: anaId }).eq('id', configs[0].id).eq('account_id', accountId)
  if (error) throw error
  for (const r of eligible) await syncHotelReservationDeal(db, accountId, r.id)
  const verified = await read(db.from('pipeline_stages').select('id,name,pipeline_id,is_won,position').in('pipeline_id', pipelines.map(p => p.id)).order('position'))
  console.log(JSON.stringify({ configured: true, stages: verified, synchronizedFutureRequests: eligible.length }, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
