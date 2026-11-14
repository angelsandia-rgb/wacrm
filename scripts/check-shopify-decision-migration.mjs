// Optional local PostgreSQL validation. Pass the installed PGlite module path
// as argv[2] when it is not available from this project's dependencies.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { PGlite } = await import(process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : '@electric-sql/pglite')
const db = new PGlite()
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const [account, other, contact, conversation, pipeline, waiting, placed, shipped, owner, agent] = Array.from({ length: 10 }, (_, i) => id(i + 1))
const deal = id(20)
const order = 'gid://shopify/Order/20'
const sql = await readFile(new URL('../supabase/migrations/179_shopify_notification_jobs.sql', import.meta.url), 'utf8')
const q = async (text, args = []) => (await db.query(text, args)).rows
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE accounts(id UUID PRIMARY KEY);
    CREATE TABLE profiles(user_id UUID PRIMARY KEY, account_id UUID, account_role TEXT);
    CREATE TABLE pipeline_stages(id UUID PRIMARY KEY, pipeline_id UUID, name TEXT, position INTEGER);
    CREATE TABLE deals(id UUID PRIMARY KEY, account_id UUID, contact_id UUID, pipeline_id UUID, stage_id UUID, title TEXT, shopify_order_id TEXT, status TEXT DEFAULT 'open');
    CREATE TABLE conversations(id UUID PRIMARY KEY, account_id UUID, contact_id UUID, assigned_agent_id UUID,
      ai_autoreply_disabled BOOLEAN, ai_handoff_summary TEXT, ai_handoff_at TIMESTAMPTZ, ai_handoff_transient BOOLEAN);
    CREATE TABLE messages(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID, sender_type TEXT, content_type TEXT, content_text TEXT, status TEXT);
    CREATE TABLE notifications(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), account_id UUID, user_id UUID, type TEXT, conversation_id UUID, title TEXT, body TEXT);
  `)
  await db.exec(sql)
  await db.exec(sql) // Migration must remain repeatable.
  await q('INSERT INTO accounts VALUES ($1),($2)', [account, other])
  await q('INSERT INTO profiles VALUES ($1,$3,\'owner\'),($2,$3,\'agent\')', [owner, agent, account])
  await q('INSERT INTO pipeline_stages VALUES ($1,$4,\'Por confirmar\',0),($2,$4,\'Pedido creado\',1),($3,$4,\'Enviado\',3)', [waiting, placed, shipped, pipeline])
  await q('INSERT INTO conversations(id,account_id,contact_id) VALUES ($1,$2,$3)', [conversation, account, contact])
  const reset = async (stage = waiting) => {
    await db.exec('TRUNCATE notifications, messages, shopify_notification_jobs, deals')
    await q('UPDATE conversations SET assigned_agent_id=NULL,ai_autoreply_disabled=false,ai_handoff_summary=NULL,ai_handoff_at=NULL')
    await q('INSERT INTO deals(id,account_id,contact_id,pipeline_id,stage_id,title,shopify_order_id) VALUES ($1,$2,$3,$4,$5,\'Pedido Shopify #1005\',$6)', [deal, account, contact, pipeline, stage, order])
  }
  const decide = (decision, acct = account, handoff = null) => q('SELECT record_shopify_order_decision($1,$2,$3,$4,$5,$6) AS result', [acct, deal, order, conversation, decision, handoff])
  const snapshot = async () => ({
    deals: await q('SELECT * FROM deals'), jobs: await q('SELECT * FROM shopify_notification_jobs'),
    conversations: await q('SELECT * FROM conversations'), messages: await q('SELECT * FROM messages'), notifications: await q('SELECT * FROM notifications'),
  })

  await reset()
  await decide('confirm')
  let state = await snapshot()
  assert.equal(state.deals[0].shopify_confirmation_decision, 'confirm')
  assert.equal(state.deals[0].stage_id, placed)
  assert.equal(state.notifications.length, 1)
  assert.equal(state.jobs.length, 1)
  assert.deepEqual(state.jobs[0].payload.decision, { orderId: order, decision: 'confirm' })
  const original = state
  await Promise.all([decide('confirm'), decide('confirm')])
  assert.deepEqual(await snapshot(), original, 'same decision must not duplicate staff alerts or jobs')
  await assert.rejects(decide('cancel'), /different decision/)
  assert.deepEqual(await snapshot(), original, 'opposite decision must not change the committed answer')
  await assert.rejects(decide('confirm', other), /not found/)
  await assert.rejects(decide('unknown'), /Invalid Shopify/)

  await reset()
  await q(`UPDATE deals SET status='lost'`)
  await assert.rejects(decide('confirm'), /no longer open/)
  assert.equal((await snapshot()).jobs.length, 0)
  assert.equal((await snapshot()).deals[0].shopify_confirmation_decision, null)

  await reset(shipped)
  await decide('confirm')
  assert.equal((await snapshot()).deals[0].stage_id, shipped, 'confirmation must not regress a shipped order')

  await reset()
  // A late queue failure must roll back the earlier decision, stage and alerts.
  await db.exec(`ALTER TABLE shopify_notification_jobs ADD CONSTRAINT injected_queue_failure CHECK (event_key NOT LIKE '%:decision')`)
  const beforeFailure = await snapshot()
  await assert.rejects(decide('confirm'), /injected_queue_failure/)
  assert.deepEqual(await snapshot(), beforeFailure)
  await db.exec('ALTER TABLE shopify_notification_jobs DROP CONSTRAINT injected_queue_failure')
  await decide('confirm')
  assert.equal((await snapshot()).jobs.length, 1)

  await reset()
  await db.exec(`ALTER TABLE notifications ADD CONSTRAINT injected_notification_failure CHECK (type <> 'ai_handoff')`)
  const beforeAlertFailure = await snapshot()
  await assert.rejects(decide('cancel'), /injected_notification_failure/)
  assert.deepEqual(await snapshot(), beforeAlertFailure, 'failed staff notification must roll back the handoff and note too')
  await db.exec('ALTER TABLE notifications DROP CONSTRAINT injected_notification_failure')
  await decide('cancel')
  state = await snapshot()
  assert.equal(state.deals[0].shopify_confirmation_decision, 'cancel')
  assert.equal(state.conversations[0].ai_autoreply_disabled, true)
  assert.equal(state.messages.length, 1)
  assert.equal(state.notifications.length, 2)
  assert.equal(state.jobs.length, 1)
  // A later manual resume must not be undone by a repeated webhook/AI decision.
  await q('UPDATE conversations SET ai_autoreply_disabled=false')
  const resumed = await snapshot()
  await decide('cancel')
  assert.deepEqual(await snapshot(), resumed)

  await reset()
  await q('UPDATE conversations SET assigned_agent_id=$1', [owner])
  await decide('cancel', account, id(999)) // An obsolete fallback must not replace/block the current teammate.
  assert.equal((await snapshot()).conversations[0].assigned_agent_id, owner, 'do not replace a human already on the chat')
  assert.equal((await snapshot()).notifications[0].user_id, owner, 'an already-assigned teammate still needs a new cancellation alert')
  assert.equal((await snapshot()).notifications.length, 1)

  await db.exec('SET ROLE authenticated')
  await assert.rejects(decide('cancel'), /permission denied for function/)
  await db.exec('RESET ROLE')
  const permissions = await q(`SELECT has_function_privilege('service_role', 'record_shopify_order_decision(uuid,uuid,text,uuid,text,uuid)', 'EXECUTE') AS allowed`)
  assert.equal(permissions[0].allowed, true)
  const claim = async (acct = account) => (await q('SELECT claim_shopify_order_attempt($1,$2) AS result', [acct, conversation]))[0].result
  const first = await claim()
  assert.equal(first.acquired, true)
  assert.equal((await claim()).acquired, false, 'another worker must not acquire the active conversation')
  await q(`UPDATE shopify_order_attempts SET status='processing',created_at=now()-interval '11 minutes'`)
  const interrupted = await claim()
  assert.equal(interrupted.acquired, false)
  assert.equal(interrupted.status, 'blocked', 'interrupted calls need reconciliation, never an automatic remote retry')
  await q(`UPDATE shopify_order_attempts SET created_at=now()-interval '2 days'`)
  assert.equal((await claim()).acquired, false, 'an uncertain outcome does not expire into a duplicate order')
  await q(`UPDATE shopify_order_attempts SET status='succeeded',created_at=now()`)
  assert.equal((await claim()).acquired, false)
  await q(`UPDATE shopify_order_attempts SET created_at=now()-interval '31 minutes'`)
  const next = await claim()
  assert.equal(next.acquired, true, 'a completed order permits a later separate purchase')
  assert.notEqual(next.token, first.token)
  await q(`UPDATE shopify_order_attempts SET status='failed'`)
  assert.equal((await claim()).acquired, true, 'failures before remote creation permit a safe retry')
  await assert.rejects(claim(other), /conversation not found/)
  await db.exec('SET ROLE authenticated')
  await assert.rejects(claim(), /permission denied for function/)
  await db.exec('RESET ROLE')
  console.log('PASS: migration twice; atomic decision/stage/handoff/alerts/job; conflict and tenant guards; replays; late-failure rollback; staff assignment; shared creation claim, cooldown and uncertain outcomes; service-role permissions.')
  console.log('PGlite uses one local PostgreSQL connection; this does not replace a multi-session load test or a real Shopify/WhatsApp integration test.')
} finally {
  await db.close()
}
