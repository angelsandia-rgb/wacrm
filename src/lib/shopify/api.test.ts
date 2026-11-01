import { createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'
import { buildOrderInput, departamentoCode, mapShopifyProduct, normalizeGtPhone, verifyShopifyHmac } from './api'
import { parseShopifyOrderPayload } from '@/lib/ai/generate'

const variant = (over: Partial<{ inventoryQuantity: number; inventoryPolicy: 'DENY' | 'CONTINUE'; tracked: boolean }> = {}) => ({
  id: 'gid://shopify/ProductVariant/1',
  price: '199.00',
  inventoryQuantity: over.inventoryQuantity ?? 5,
  inventoryPolicy: over.inventoryPolicy ?? 'DENY',
  inventoryItem: { tracked: over.tracked ?? true },
})
const product = (v: ReturnType<typeof variant>) => ({
  title: ' Lámpara Ceiba ',
  description: 'Luz  cálida\n para tu sala',
  featuredMedia: { preview: { image: { url: 'https://cdn/x.jpg' } } },
  variants: { nodes: [v] },
})

describe('mapShopifyProduct', () => {
  it('maps price, image, plain description', () => {
    expect(mapShopifyProduct(product(variant()))).toEqual({
      shopify_variant_id: 'gid://shopify/ProductVariant/1', name: 'Lámpara Ceiba', price: 199,
      description: 'Luz cálida para tu sala', image_url: 'https://cdn/x.jpg', is_active: true,
    })
  })
  it('deactivates tracked zero-stock variants unless overselling is allowed', () => {
    expect(mapShopifyProduct(product(variant({ inventoryQuantity: 0 })))?.is_active).toBe(false)
    expect(mapShopifyProduct(product(variant({ inventoryQuantity: 0, inventoryPolicy: 'CONTINUE' })))?.is_active).toBe(true)
    expect(mapShopifyProduct(product(variant({ inventoryQuantity: 0, tracked: false })))?.is_active).toBe(true)
  })
})

describe('buildOrderInput', () => {
  it('builds a pending COD order with the store gateway name and tag', () => {
    const input = buildOrderInput({
      lines: [{ variantId: 'gid://v/1', quantity: 2, price: 169, title: 'X' }],
      fullName: 'Ana María López', phone: '5555 1234', address: 'Zona 10, 5a avenida 1-23',
      departamento: 'Sacatepéquez', payment: 'cod', currency: 'GTQ',
    })
    expect(input.financialStatus).toBe('PENDING')
    expect(input.tags).toEqual(['chat-sandia'])
    expect(input.phone).toBe('+50255551234')
    expect(input.shippingAddress).toMatchObject({ firstName: 'Ana María', lastName: 'López', provinceCode: 'SAC', countryCode: 'GT' })
    expect(input.transactions).toEqual([{
      kind: 'SALE', status: 'PENDING', gateway: 'Pago contra entrega (COD)',
      amountSet: { shopMoney: { amount: '338.00', currencyCode: 'GTQ' } },
    }])
  })
})

describe('helpers', () => {
  it('normalizes GT phones and departamentos', () => {
    expect(normalizeGtPhone('+502 5555-1234')).toBe('+50255551234')
    expect(departamentoCode('peten')).toBe('PET')
    expect(departamentoCode('Narnia')).toBeUndefined()
  })
  it('verifies the webhook HMAC', () => {
    const body = '{"id":1}'
    const sig = createHmac('sha256', 's3cret').update(body).digest('base64')
    expect(verifyShopifyHmac(body, sig, 's3cret')).toBe(true)
    expect(verifyShopifyHmac(body + ' ', sig, 's3cret')).toBe(false)
    expect(verifyShopifyHmac(body, null, 's3cret')).toBe(false)
  })
})

describe('parseShopifyOrderPayload', () => {
  it('parses a complete marker', () => {
    expect(parseShopifyOrderPayload('Lámpara Ceiba:2,Cojín: 1|Ana López|55551234|Zona 1, 6a calle|Guatemala|contra entrega')).toEqual({
      items: [{ name: 'Lámpara Ceiba', qty: 2 }, { name: 'Cojín', qty: 1 }],
      fullName: 'Ana López', phone: '55551234', address: 'Zona 1, 6a calle', departamento: 'Guatemala', payment: 'cod',
    })
    expect(parseShopifyOrderPayload('Cojín:1|Ana|55551234|Zona 1|Guatemala|tarjeta')?.payment).toBe('card')
  })
  it('rejects a marker with a missing field', () => {
    expect(parseShopifyOrderPayload('Cojín:1|Ana|55551234|Zona 1|Guatemala|')).toBeNull()
    expect(parseShopifyOrderPayload('Cojín:1|Ana||Zona 1|Guatemala|cod')).toBeNull()
  })
})
