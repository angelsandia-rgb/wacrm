/** Scoped, repeatable VSR policy update. Default: read-only plan; --apply writes a backup first. */
import { config } from 'dotenv'
import { writeFileSync, mkdirSync } from 'node:fs'
import { holyWeek, yearEndWeeks } from '../../src/lib/products/hotel-seasons'
config({ path: '.env', quiet: true })
const ACCOUNT = '09cd99b6-db6e-4644-a76b-01b11f7364f7'
const JUNIOR = '19bad90c-7cdd-4002-ab20-330b1b70da93'
const DOUBLE = 'b308980b-d61e-46fa-afa8-6ac98e30b76c'
const DISPUTED = new Set([JUNIOR, DOUBLE, 'a7e663fd-d317-4f8b-a196-24c6aa251b3b', 'c813ab78-447c-48ac-9fae-e4fcb7aca48b'])
const PERIODS = [
 { oldFrom: '2026-12-24', oldTo: '2027-01-01', ...yearEndWeeks(2026) },
 { oldFrom: '2027-03-21', oldTo: '2027-03-27', ...holyWeek(2027) },
 { oldFrom: '2027-12-24', oldTo: '2028-01-01', ...yearEndWeeks(2027) },
]
const DATES = PERIODS.map(p => `${p.from} al ${p.to}`).join('; ')
const KIDS = 'Los ni\u00f1os tambi\u00e9n tienen desayuno incluido. Los menores de 6 a\u00f1os no pagan, incluido su desayuno, pero cuentan para la capacidad. De 6 a 12 a\u00f1os: Q200 en temporada alta; se conservan Q175 domingo-jueves y Q200 viernes-s\u00e1bado de temporada normal. Para mayores de 12 a\u00f1os el hotel confirma la tarifa aplicable. Esto no autoriza ni\u00f1os en categor\u00edas que los proh\u00edben.'
const BED = 'Cama adicional: \u00fanicamente en Junior Suite Familiar. La imagen de temporada alta publica Q400. No ofrecerla en otras habitaciones ni paquetes. La aplicaci\u00f3n por noche/estad\u00eda y su relaci\u00f3n con la tarifa de cinco personas las confirma el hotel; no sumar dos veces ni afirmar que siempre viene incluida.'
const PENDING = 'Tarifas de temporada alta pendientes de confirmaci\u00f3n del hotel. No cotizar autom\u00e1ticamente importes de adultos ni reutilizar estimados anteriores para esas temporadas.'
const PREFIX = '\n\nPOL\u00cdTICAS CONFIRMADAS 18/10/2026 - NI\u00d1OS, CAMA Y TEMPORADAS\n'
const POLICY = `${PREFIX}Estas aclaraciones prevalecen sobre las menciones anteriores de estos mismos temas.\n${KIDS}\n${BED}\nSemanas completas lunes-domingo, por noche ocupada: ${DATES}. Las semanas de Navidad y A\u00f1o Nuevo se unen sin huecos.\nPremium: temporada alta 1 persona Q450 y 2 personas Q870 por habitaci\u00f3n/noche. Master Deluxe, Cl\u00e1sicas y Junior: la relaci\u00f3n ocupaci\u00f3n/precio del banner sigue pendiente. No interpretar sus columnas ni trasladar una tarifa normal a temporada alta.\nNo cambia el horario de la IA ni autoriza pagos, disponibilidad, cambios o cancelaciones de reservas.\n`
function replacePolicy(content: string) { return content.split(PREFIX)[0] + POLICY }
async function main() {
 const { createClient } = await import('@supabase/supabase-js')
 const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
 const [account, ai, products, rates, docs] = await Promise.all([
  db.from('accounts').select('id,name').eq('id',ACCOUNT).single(),
  db.from('ai_configs').select('id,system_prompt,updated_at').eq('account_id',ACCOUNT).single(),
  db.from('products').select('id,name,description,updated_at,category:product_categories(name)').eq('account_id',ACCOUNT),
  db.from('product_rates').select('id,product_id,day_of_week,occupancy,price,date_from,date_to').eq('account_id',ACCOUNT),
  db.from('ai_knowledge_documents').select('id,title,content,updated_at').eq('account_id',ACCOUNT),
 ])
 for (const r of [account,ai,products,rates,docs]) if (r.error) throw r.error
 if (account.data?.name !== 'Villa San Ricardo' || !ai.data) throw new Error('Account validation failed')
 const prompt = replacePolicy((ai.data.system_prompt ?? '')
  .replace(/^  Cama adicional:.*$/m, '  ' + BED)
  .replace(/^  - Temporada alta.*$/m, `  - Temporada alta por semanas completas: ${DATES}. Premium confirmada; ocupaciones/precios de las otras habitaciones pendientes del hotel.`)
  .replace(/^  - Ni\u00f1os:.*$/m, '  - ' + KIDS))
 const plannedProducts = (products.data ?? []).filter(p => DISPUTED.has(p.id)).map(p => {
  const base = (p.description ?? '').split('\nPOLITICA CONFIRMADA 18/10/2026:')[0]
  const family = p.id === JUNIOR || p.id === DOUBLE
  return { ...p, next: base + '\nPOLITICA CONFIRMADA 18/10/2026: Incluye desayuno y parqueo. ' + (family ? KIDS + ' ' : '') + (p.id === JUNIOR ? BED + ' ' : 'Cama adicional no disponible en esta categoria. ') + PENDING }
 })
 const plannedDocs = (docs.data ?? []).filter(d => ['Tarifas', 'Pol\u00edticas y horarios'].includes(d.title)).map(d => {
  let text = d.content.split(PREFIX)[0]
  text = text.replace(/Cama adicional: solo en la Junior Suite Familiar[^\n]*/g, BED)
  text = text.replace(/Menores de 6 a\u00f1os: sin costo\./g, 'Menores de 6 a\u00f1os: sin costo, incluido el desayuno.')
  if (d.title === 'Tarifas') {
   const start = text.indexOf('TEMPORADA ALTA')
   const end = text.indexOf('\n\nNOTAS', start)
   if (start < 0 || end < 0) throw new Error('Tariff knowledge section was not found')
   text = text.slice(0,start) + `TEMPORADA ALTA - SEMANAS COMPLETAS\nPeriodos por noche ocupada: ${DATES}.\n- Suite Premium: 1 persona Q450; 2 personas Q870 por habitacion/noche.\n- Master Deluxe, Suite Clasica, Clasica Doble y Junior: ocupaciones/precios pendientes de confirmacion del hotel; no cotizar importes de adulto ni extrapolar tarifas normales.\n- Ninos de 6 a 12 anos: Q200 con desayuno incluido. Menores de 6 no pagan y tienen desayuno incluido.\n- ${BED}\n` + text.slice(end)
  }
  return { ...d, next: replacePolicy(text) }
 })
 if (plannedProducts.length !== 4 || plannedDocs.length !== 2) throw new Error('Unexpected products/documents')
 const childRows = []
 for (const day of ['mon','tue','wed','thu','fri','sat','sun']) {
  if (!(rates.data ?? []).some(r=>r.product_id===DOUBLE && r.occupancy==='child' && r.day_of_week===day && !r.date_from))
   childRows.push({account_id:ACCOUNT,product_id:DOUBLE,day_of_week:day,occupancy:'child',price:['fri','sat'].includes(day)?200:175,date_from:null,date_to:null})
  for (const period of PERIODS) if (!(rates.data ?? []).some(r=>r.product_id===DOUBLE && r.occupancy==='child' && r.day_of_week===day && [period.from,period.oldFrom].includes(r.date_from ?? '')))
   childRows.push({account_id:ACCOUNT,product_id:DOUBLE,day_of_week:day,occupancy:'child',price:200,date_from:period.from,date_to:period.to})
 }
 console.log(JSON.stringify({ account: account.data.name, periods: PERIODS, childRowsToAdd: childRows.length, products: plannedProducts.map(p=>p.name), documents: plannedDocs.map(d=>d.title), apply: process.argv.includes('--apply') }))
 if (!process.argv.includes('--apply')) return
 mkdirSync('outputs',{recursive:true})
 const backup = `outputs/vsr-policy-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`
 writeFileSync(backup, JSON.stringify({ account: account.data, ai: ai.data, products: products.data, rates: rates.data, docs: docs.data },null,2))
 console.log('BACKUP',backup)
 // Hide disputed seasonal adult prices first, before extending any dates.
 for (const p of plannedProducts) {
  const r=await db.from('products').update({description:p.next}).eq('account_id',ACCOUNT).eq('id',p.id).eq('updated_at',p.updated_at).select('id')
  if(r.error||r.data?.length!==1)throw new Error(`Product update failed: ${p.name}`)
 }
 for(const period of PERIODS) {
  const r=await db.from('product_rates').update({date_from:period.from,date_to:period.to}).eq('account_id',ACCOUNT).eq('date_from',period.oldFrom).eq('date_to',period.oldTo).select('id')
  if(r.error)throw r.error
  console.log('PERIOD_UPDATED',period.from,period.to,r.data?.length)
 }
 if(childRows.length){const r=await db.from('product_rates').insert(childRows);if(r.error)throw r.error}
 const configUpdate=await db.from('ai_configs').update({system_prompt:prompt}).eq('account_id',ACCOUNT).eq('id',ai.data.id).eq('updated_at',ai.data.updated_at).select('id')
 if(configUpdate.error||configUpdate.data?.length!==1)throw new Error('AI config update failed')
 const {loadEmbeddingsKey}=await import('../../src/lib/ai/config')
 const {ingestDocument}=await import('../../src/lib/ai/knowledge')
 const embedding=await loadEmbeddingsKey(db,ACCOUNT)
 for(const d of plannedDocs){
  const r=await db.from('ai_knowledge_documents').update({content:d.next}).eq('account_id',ACCOUNT).eq('id',d.id).eq('updated_at',d.updated_at).select('id')
  if(r.error||r.data?.length!==1)throw new Error(`Document update failed: ${d.title}`)
  await ingestDocument(db,ACCOUNT,{embeddingsApiKey:embedding.key},d.id,d.next)
 }
 console.log('APPLIED',JSON.stringify({childRowsAdded:childRows.length,adultAmountsChanged:0,periods:PERIODS.map(({from,to})=>({from,to}))}))
}
main().catch(error=>{console.error(error instanceof Error?error.message:JSON.stringify(error));process.exitCode=1})
