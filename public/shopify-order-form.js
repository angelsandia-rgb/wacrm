/*
 * Chat Sandía — the store's own cash-on-delivery order form.
 *
 * Theme usage (product page):
 *   <button type="button" data-sandia-order data-title="{{ product.title }}">Pedir, pago contra entrega</button>
 *   <script src="https://chatsandia.com/shopify-order-form.js" data-account="ACCOUNT_UUID" defer></script>
 *
 * The variant is the one selected in the product form (input name="id"), or
 * data-variant-id on the button. Submitting saves an order REQUEST in the
 * CRM, which asks the customer on WhatsApp; the Shopify order is created
 * only after their "sí" (or card payment). No cookies, no tracking.
 */
(function () {
  var script = document.currentScript
  if (!script) return
  var account = script.getAttribute('data-account')
  var endpoint = new URL('/api/shopify/order-form?account=' + encodeURIComponent(account || ''), script.src).href
  var DEPARTAMENTOS = ['Alta Verapaz', 'Baja Verapaz', 'Chimaltenango', 'Chiquimula', 'El Progreso', 'Escuintla', 'Guatemala',
    'Huehuetenango', 'Izabal', 'Jalapa', 'Jutiapa', 'Petén', 'Quetzaltenango', 'Quiché', 'Retalhuleu', 'Sacatepéquez',
    'San Marcos', 'Santa Rosa', 'Sololá', 'Suchitepéquez', 'Totonicapán', 'Zacapa']

  var css = '.sof-back{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:flex-end;justify-content:center;z-index:2147483000}' +
    '@media(min-width:640px){.sof-back{align-items:center}}' +
    '.sof{background:#fff;color:#111;width:100%;max-width:440px;max-height:92vh;overflow:auto;border-radius:14px 14px 0 0;padding:20px;font:15px/1.4 system-ui,sans-serif;box-sizing:border-box}' +
    '@media(min-width:640px){.sof{border-radius:14px}}' +
    '.sof h2{margin:0 0 4px;font-size:18px}.sof p{margin:0 0 14px;color:#555}' +
    '.sof label{display:block;margin:10px 0 4px;font-weight:600;font-size:14px}' +
    '.sof input,.sof select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #bbb;border-radius:8px;font:inherit;background:#fff;color:#111}' +
    '.sof .sof-row{display:flex;gap:10px}.sof .sof-row>div{flex:1}' +
    '.sof button{width:100%;margin-top:16px;padding:13px;border:0;border-radius:8px;background:#111;color:#fff;font:inherit;font-weight:700;cursor:pointer}' +
    '.sof button[disabled]{opacity:.6;cursor:wait}.sof .sof-x{background:none;color:#555;margin-top:8px;font-weight:400}' +
    '.sof .sof-msg{margin-top:12px;padding:10px;border-radius:8px}.sof .sof-err{background:#fde8e8;color:#8a1c1c}.sof .sof-ok{background:#e6f6ea;color:#14532d}' +
    '.sof .sof-hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}'

  function el(tag, attrs, text) {
    var e = document.createElement(tag)
    for (var k in attrs) e.setAttribute(k, attrs[k])
    if (text) e.textContent = text
    return e
  }
  function field(form, label, name, attrs) {
    var id = 'sof-' + name
    var wrap = el('div')
    wrap.appendChild(el('label', { for: id }, label))
    var input = el(attrs.tag || 'input', Object.assign({ id: id, name: name }, attrs.tag ? {} : attrs))
    if (attrs.tag === 'select') {
      input.required = true
      input.appendChild(el('option', { value: '' }, 'Elija su departamento'))
      DEPARTAMENTOS.forEach(function (d) { input.appendChild(el('option', { value: d }, d)) })
    }
    wrap.appendChild(input)
    form.appendChild(wrap)
    return wrap
  }

  function selectedVariant(button) {
    if (button.getAttribute('data-variant-id')) return button.getAttribute('data-variant-id')
    var scope = button.closest('product-info, .product, main') || document
    var input = scope.querySelector('form[action*="/cart/add"] [name="id"]') || document.querySelector('form[action*="/cart/add"] [name="id"]')
    return input && input.value
  }

  function open(button) {
    var variantId = selectedVariant(button)
    var back = el('div', { class: 'sof-back' })
    var box = el('div', { class: 'sof', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sof-title' })
    var form = el('form', { novalidate: '' })
    box.appendChild(el('h2', { id: 'sof-title' }, 'Pedir con pago contra entrega'))
    box.appendChild(el('p', {}, (button.getAttribute('data-title') || 'Su pedido') + '. Le escribimos por WhatsApp para confirmarlo; puede pagar en efectivo al recibir o con tarjeta.'))
    field(form, 'Cantidad', 'quantity', { type: 'number', min: '1', max: '20', value: '1', inputmode: 'numeric', required: '' })
    field(form, 'Nombre completo', 'fullName', { autocomplete: 'name', required: '' })
    field(form, 'Teléfono (WhatsApp)', 'phone', { type: 'tel', autocomplete: 'tel-national', inputmode: 'numeric', placeholder: '8 dígitos', required: '' })
    field(form, 'Dirección: casa, calle, colonia o aldea, número', 'address', { autocomplete: 'street-address', required: '' })
    field(form, 'Punto de referencia (recomendado)', 'reference', {})
    var row = el('div', { class: 'sof-row' })
    form.appendChild(row)
    row.appendChild(field(form, 'Departamento', 'departamento', { tag: 'select' }))
    row.appendChild(field(form, 'Municipio', 'municipio', { required: '' }))
    var hp = el('div', { class: 'sof-hp', 'aria-hidden': 'true' })
    hp.appendChild(el('input', { name: 'website', tabindex: '-1', autocomplete: 'off' }))
    form.appendChild(hp)
    var submit = el('button', { type: 'submit' }, 'Enviar pedido')
    var close = el('button', { type: 'button', class: 'sof-x' }, 'Cancelar')
    var msg = el('div', { role: 'status', 'aria-live': 'polite' })
    form.appendChild(submit)
    form.appendChild(close)
    form.appendChild(msg)
    box.appendChild(form)
    back.appendChild(box)
    document.body.appendChild(back)
    form.querySelector('[name="quantity"]').focus()

    function done() { back.remove(); document.removeEventListener('keydown', onKey); button.focus() }
    function onKey(e) { if (e.key === 'Escape') done() }
    document.addEventListener('keydown', onKey)
    close.addEventListener('click', done)
    back.addEventListener('click', function (e) { if (e.target === back) done() })
    function show(kind, text) { msg.className = 'sof-msg ' + kind; msg.textContent = text }

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var data = new FormData(form)
      var missing = ['fullName', 'phone', 'address', 'departamento', 'municipio'].filter(function (k) { return !String(data.get(k) || '').trim() })
      if (!variantId) return show('sof-err', 'Elija una variante del producto.')
      if (missing.length) return show('sof-err', 'Complete los campos obligatorios.')
      submit.disabled = true
      show('', 'Enviando…')
      fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: [{ variantId: String(variantId), quantity: Number(data.get('quantity')) || 1 }],
          fullName: data.get('fullName'), phone: data.get('phone'), address: data.get('address'), reference: data.get('reference'),
          departamento: data.get('departamento'), municipio: data.get('municipio'), website: data.get('website'),
        }),
      }).then(function (r) { return r.json().catch(function () { return {} }).then(function (b) { return { ok: r.ok, body: b } }) })
        .then(function (res) {
          if (!res.ok) { submit.disabled = false; return show('sof-err', res.body.error || 'No pudimos enviar su pedido. Intente de nuevo.') }
          form.querySelectorAll('input,select,button[type=submit]').forEach(function (i) { i.disabled = true })
          close.textContent = 'Cerrar'
          show('sof-ok', '¡Listo! Le escribimos por WhatsApp para confirmar su pedido. Su número de pedido llega al confirmar.')
        })
        .catch(function () { submit.disabled = false; show('sof-err', 'Sin conexión. Intente de nuevo.') })
    })
  }

  document.head.appendChild(el('style', {}, css))
  document.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('[data-sandia-order]')
    if (!button) return
    e.preventDefault()
    open(button)
  })
})()
