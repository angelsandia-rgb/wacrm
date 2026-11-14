/** Scoped, reviewable prompt update. Defaults to a read-only plan.
 * Run after publishing the accompanying service/opt-out guards:
 * node --env-file=.env scripts/apply-casa-ceiba-conversation-prompt.mjs --apply
 */
import { createClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
const accountId = 'c14721dc-8895-434f-b041-64fa654e249a'
const previousHash = '47132c361a8f3fd04a50dc00ed76866de65e4bd7ec8b73e0fd7d7e4ff382b9a6'
const hash = (value) => createHash('sha256').update(value.replace(/\r\n/g, '\n').trim()).digest('hex')
const prompt = readFileSync(new URL('../docs/prompts/casa-ceiba-system-prompt-2026-11-14.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim()
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})
const { data: account, error: accountError } = await db.from('accounts').select('id,name').eq('id', accountId).single()
if (accountError || account.name !== 'Casa Ceiba') throw new Error('Unexpected account; stopping')
const { data: current, error } = await db.from('ai_configs').select('system_prompt').eq('account_id', accountId).single()
if (error) throw error
const before = current.system_prompt ?? ''
const beforeHash = hash(before), nextHash = hash(prompt)
if (beforeHash === nextHash) {
  console.log(JSON.stringify({ accountId, status: 'already-applied', promptHash: nextHash }))
} else {
  if (beforeHash !== previousHash) throw new Error('Prompt changed since audit; review the new version before applying')
  console.log(JSON.stringify({ accountId, status: 'planned', beforeHash, nextHash, apply: process.argv.includes('--apply') }))
  if (process.argv.includes('--apply')) {
    mkdirSync('tmp', { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(`tmp/cc-prompt-before-${stamp}.json`, JSON.stringify({ accountId, checkedAt: new Date().toISOString(), system_prompt: before }, null, 2))
    const saved = await db.from('ai_configs').update({ system_prompt: prompt })
      .eq('account_id', accountId).eq('system_prompt', before).select('system_prompt').single()
    if (saved.error || hash(saved.data?.system_prompt ?? '') !== nextHash) throw new Error('Prompt compare-and-set failed')
    const verify = await db.from('ai_configs').select('system_prompt').eq('account_id', accountId).single()
    if (verify.error || hash(verify.data?.system_prompt ?? '') !== nextHash) throw new Error('Prompt readback failed')
    console.log(JSON.stringify({ accountId, status: 'applied-and-verified', promptHash: nextHash }))
  }
}
