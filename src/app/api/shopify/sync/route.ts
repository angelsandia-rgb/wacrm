import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { ShopifyError, syncShopifyProducts } from '@/lib/shopify/api'

/** POST — "Sincronizar con Shopify": pull active products into the catalog. */
export async function POST() {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    try {
      return NextResponse.json(await syncShopifyProducts(supabase, accountId, userId))
    } catch (err) {
      if (err instanceof ShopifyError) return NextResponse.json({ error: err.message }, { status: err.status })
      throw err
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
