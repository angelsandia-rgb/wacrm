/*
 * Chat Sandía — the store's own cash-on-delivery order form.
 *
 * Theme usage (product page):
 *   <button type="button" data-sandia-order data-title="{{ product.title }}">Pedir, pago contra entrega</button>
 *   <script src="https://chatsandia.com/shopify-order-form.js" data-account="ACCOUNT_UUID" defer></script>
 *
 * The variant is the one selected in the product form (input name="id"), or
 * data-variant-id on the button. A button with data-sandia-cart orders the
 * whole cart instead (cart page / drawer) and empties it once sent.
 * An element with data-sandia-order-page (a "Pedido" page) shows the same form
 * inline with the cart's summary: the store's checkout page.
 * Submitting saves an order REQUEST in the
 * CRM, which asks the customer on WhatsApp; the Shopify order is created
 * only after their "sí" (or card payment). No cookies, no tracking.
 */
(function () {
  var script = document.currentScript
  if (!script) return
  var account = script.getAttribute('data-account')
  // The store's WhatsApp (digits with country code): where "Continuar por WhatsApp" opens.
  var whatsapp = (script.getAttribute('data-whatsapp') || '').replace(/\D/g, '')
  var endpoint = new URL('/api/shopify/order-form?account=' + encodeURIComponent(account || ''), script.src).href
  // Official municipios per departamento (340). A list instead of free text:
  // a mistyped municipio is what Dropi rejects after the order already exists.
  var MUNICIPIOS = {
    'Alta Verapaz': ['Cahabón', 'Chahal', 'Chisec', 'Cobán', 'Fray Bartolomé de las Casas', 'Lanquín', 'Panzós', 'Raxruhá', 'San Cristóbal Verapaz', 'San Juan Chamelco', 'San Pedro Carchá', 'Santa Catalina La Tinta', 'Santa Cruz Verapaz', 'Senahú', 'Tactic', 'Tamahú', 'Tucurú'],
    'Baja Verapaz': ['Cubulco', 'El Chol', 'Granados', 'Purulhá', 'Rabinal', 'Salamá', 'San Jerónimo', 'San Miguel Chicaj'],
    'Chimaltenango': ['Acatenango', 'Chimaltenango', 'Comalapa', 'El Tejar', 'Parramos', 'Patzicía', 'Patzún', 'Pochuta', 'San Andrés Itzapa', 'San José Poaquil', 'San Martín Jilotepeque', 'Santa Apolonia', 'Santa Cruz Balanyá', 'Tecpán Guatemala', 'Yepocapa', 'Zaragoza'],
    'Chiquimula': ['Camotán', 'Chiquimula', 'Concepción Las Minas', 'Esquipulas', 'Ipala', 'Jocotán', 'Olopa', 'Quezaltepeque', 'San Jacinto', 'San José La Arada', 'San Juan Ermita'],
    'El Progreso': ['El Jícaro', 'Guastatoya', 'Morazán', 'San Agustín Acasaguastlán', 'San Antonio La Paz', 'San Cristóbal Acasaguastlán', 'Sanarate', 'Sansare'],
    'Escuintla': ['Escuintla', 'Guanagazapa', 'Iztapa', 'La Democracia', 'La Gomera', 'Masagua', 'Nueva Concepción', 'Palín', 'San José', 'San Vicente Pacaya', 'Santa Lucía Cotzumalguapa', 'Sipacate', 'Siquinalá', 'Tiquisate'],
    'Guatemala': ['Amatitlán', 'Chinautla', 'Chuarrancho', 'Fraijanes', 'Guatemala', 'Mixco', 'Palencia', 'San José del Golfo', 'San José Pinula', 'San Juan Sacatepéquez', 'San Miguel Petapa', 'San Pedro Ayampuc', 'San Pedro Sacatepéquez', 'San Raymundo', 'Santa Catarina Pinula', 'Villa Canales', 'Villa Nueva'],
    'Huehuetenango': ['Aguacatán', 'Barillas', 'Chiantla', 'Colotenango', 'Concepción Huista', 'Cuilco', 'Huehuetenango', 'Ixtahuacán', 'Jacaltenango', 'La Democracia', 'La Libertad', 'Malacatancito', 'Nentón', 'Petatán', 'San Antonio Huista', 'San Gaspar Ixchil', 'San Juan Atitán', 'San Juan Ixcoy', 'San Mateo Ixtatán', 'San Miguel Acatán', 'San Pedro Necta', 'San Rafael La Independencia', 'San Rafael Petzal', 'San Sebastián Coatán', 'San Sebastián Huehuetenango', 'Santa Ana Huista', 'Santa Bárbara', 'Santa Eulalia', 'Santiago Chimaltenango', 'Soloma', 'Tectitán', 'Todos Santos Cuchumatán', 'Unión Cantinil'],
    'Izabal': ['El Estor', 'Livingston', 'Los Amates', 'Morales', 'Puerto Barrios'],
    'Jalapa': ['Jalapa', 'Mataquescuintla', 'Monjas', 'San Carlos Alzatate', 'San Luis Jilotepeque', 'San Manuel Chaparrón', 'San Pedro Pinula'],
    'Jutiapa': ['Agua Blanca', 'Asunción Mita', 'Atescatempa', 'Comapa', 'Conguaco', 'El Adelanto', 'El Progreso', 'Jalpatagua', 'Jerez', 'Jutiapa', 'Moyuta', 'Pasaco', 'Quesada', 'San José Acatempa', 'Santa Catarina Mita', 'Yupiltepeque', 'Zapotitlán'],
    'Petén': ['Dolores', 'El Chal', 'Flores', 'La Libertad', 'Las Cruces', 'Melchor de Mencos', 'Poptún', 'San Andrés', 'San Benito', 'San Francisco', 'San José', 'San Luis', 'Santa Ana', 'Sayaxché'],
    'Quetzaltenango': ['Almolonga', 'Cabricán', 'Cajolá', 'Cantel', 'Coatepeque', 'Colomba', 'Concepción Chiquirichapa', 'El Palmar', 'Flores Costa Cuca', 'Génova', 'Huitán', 'La Esperanza', 'Olintepeque', 'Ostuncalco', 'Palestina de Los Altos', 'Quetzaltenango', 'Salcajá', 'San Carlos Sija', 'San Francisco La Unión', 'San Martín Sacatepéquez', 'San Mateo', 'San Miguel Sigüilá', 'Sibilia', 'Zunil'],
    'Quiché': ['Canillá', 'Chajul', 'Chicamán', 'Chiché', 'Chichicastenango', 'Chinique', 'Cunén', 'Ixcán', 'Joyabaj', 'Nebaj', 'Pachalum', 'Patzité', 'Sacapulas', 'San Andrés Sajcabajá', 'San Antonio Ilotenango', 'San Bartolomé Jocotenango', 'San Juan Cotzal', 'San Pedro Jocopilas', 'Santa Cruz del Quiché', 'Uspantán', 'Zacualpa'],
    'Retalhuleu': ['Champerico', 'El Asintal', 'Nuevo San Carlos', 'Retalhuleu', 'San Andrés Villa Seca', 'San Felipe', 'San Martín Zapotitlán', 'San Sebastián', 'Santa Cruz Muluá'],
    'Sacatepéquez': ['Alotenango', 'Antigua Guatemala', 'Ciudad Vieja', 'Jocotenango', 'Magdalena Milpas Altas', 'Pastores', 'San Antonio Aguas Calientes', 'San Bartolomé Milpas Altas', 'San Lucas Sacatepéquez', 'San Miguel Dueñas', 'Santa Catarina Barahona', 'Santa Lucía Milpas Altas', 'Santa María de Jesús', 'Santiago Sacatepéquez', 'Santo Domingo Xenacoj', 'Sumpango'],
    'San Marcos': ['Ayutla', 'Catarina', 'Comitancillo', 'Concepción Tutuapa', 'El Quetzal', 'El Rodeo', 'El Tumbador', 'Esquipulas Palo Gordo', 'Ixchiguán', 'La Blanca', 'La Reforma', 'Malacatán', 'Nuevo Progreso', 'Ocós', 'Pajapita', 'Río Blanco', 'San Antonio Sacatepéquez', 'San Cristóbal Cucho', 'San José Ojetenam', 'San Lorenzo', 'San Marcos', 'San Miguel Ixtahuacán', 'San Pablo', 'San Pedro Sacatepéquez', 'San Rafael Pie de la Cuesta', 'Sibinal', 'Sipacapa', 'Tacaná', 'Tajumulco', 'Tejutla'],
    'Santa Rosa': ['Barberena', 'Casillas', 'Chiquimulilla', 'Cuilapa', 'Guazacapán', 'Nueva Santa Rosa', 'Oratorio', 'Pueblo Nuevo Viñas', 'San Juan Tecuaco', 'San Rafael Las Flores', 'Santa Cruz Naranjo', 'Santa María Ixhuatán', 'Santa Rosa de Lima', 'Taxisco'],
    'Sololá': ['Concepción', 'Nahualá', 'Panajachel', 'San Andrés Semetabaj', 'San Antonio Palopó', 'San José Chacayá', 'San Juan La Laguna', 'San Lucas Tolimán', 'San Marcos La Laguna', 'San Pablo La Laguna', 'San Pedro La Laguna', 'Santa Catarina Ixtahuacán', 'Santa Catarina Palopó', 'Santa Clara La Laguna', 'Santa Cruz La Laguna', 'Santa Lucía Utatlán', 'Santa María Visitación', 'Santiago Atitlán', 'Sololá'],
    'Suchitepéquez': ['Chicacao', 'Cuyotenango', 'Mazatenango', 'Patulul', 'Pueblo Nuevo', 'Río Bravo', 'Samayac', 'San Antonio Suchitepéquez', 'San Bernardino', 'San Francisco Zapotitlán', 'San Gabriel', 'San José El Ídolo', 'San José La Máquina', 'San Juan Bautista', 'San Lorenzo', 'San Miguel Panán', 'San Pablo Jocopilas', 'Santa Bárbara', 'Santo Domingo Suchitepéquez', 'Santo Tomás La Unión', 'Zunilito'],
    'Totonicapán': ['Momostenango', 'San Andrés Xecul', 'San Bartolo', 'San Cristóbal Totonicapán', 'San Francisco El Alto', 'Santa Lucía La Reforma', 'Santa María Chiquimula', 'Totonicapán'],
    'Zacapa': ['Cabañas', 'Estanzuela', 'Gualán', 'Huité', 'La Unión', 'Río Hondo', 'San Diego', 'San Jorge', 'Teculután', 'Usumatlán', 'Zacapa'],
  }
  var DEPARTAMENTOS = Object.keys(MUNICIPIOS)

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
    '.sof-page .sof{max-width:560px;max-height:none;margin:0 auto;border:1px solid #ddd;border-radius:14px}' +
    '.sof-sum{list-style:none;margin:0 0 14px;padding:12px;background:#f6f6f6;border-radius:8px}.sof-sum li{display:flex;justify-content:space-between;gap:12px;padding:3px 0}.sof-sum .sof-total{font-weight:700;border-top:1px solid #ddd;margin-top:6px;padding-top:8px}' +
    '.sof h3{margin:18px 0 2px;font-size:16px}.sof .sof-note{margin:0 0 8px;font-size:13px}' +
    '.sof .sof-pay{display:flex;align-items:flex-start;gap:10px;margin:0 0 8px;padding:12px;border:1px solid #bbb;border-radius:8px;font-weight:400;cursor:pointer}' +
    '.sof .sof-pay input{width:auto;margin:3px 0 0}.sof .sof-pay b{display:block}.sof .sof-pay small{color:#555}' +
    '.sof .sof-wa{display:block;margin-top:12px;padding:13px;border-radius:8px;background:#25D366;color:#fff;font-weight:700;text-align:center;text-decoration:none}' +
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
      fill(input, attrs.placeholder, attrs.options || [])
    }
    wrap.appendChild(input)
    form.appendChild(wrap)
    return wrap
  }

  function fill(select, placeholder, options) {
    select.textContent = ''
    select.appendChild(el('option', { value: '' }, placeholder))
    options.forEach(function (o) { select.appendChild(el('option', { value: o }, o)) })
  }

  function selectedVariant(button) {
    if (button.getAttribute('data-variant-id')) return button.getAttribute('data-variant-id')
    var scope = button.closest('product-info, .product, main') || document
    var input = scope.querySelector('form[action*="/cart/add"] [name="id"]') || document.querySelector('form[action*="/cart/add"] [name="id"]')
    return input && input.value
  }

  // cartItems: the cart's lines when the button orders the whole cart.
  // mount: the page element to render into (order page) instead of a dialog;
  // summary: that page's cart summary, shown above the fields.
  function open(button, cartItems, mount, summary) {
    var variantId = cartItems ? null : selectedVariant(button)
    var back = mount || el('div', { class: 'sof-back' })
    var box = el('div', mount ? { class: 'sof' } : { class: 'sof', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'sof-title' })
    var form = el('form', { novalidate: '' })
    box.appendChild(el('h2', { id: 'sof-title' }, mount ? 'Confirmar pedido' : 'Pedir con pago contra entrega'))
    var title = cartItems ? 'Su carrito (' + cartItems.length + (cartItems.length === 1 ? ' producto)' : ' productos)') : button.getAttribute('data-title') || 'Su pedido'
    box.appendChild(el('p', {}, title + '. Falta un paso: le enviamos el resumen por WhatsApp y usted lo acepta ahí. No tiene que volver a escribir sus datos.'))
    if (summary) box.appendChild(summary)
    if (!cartItems) field(form, 'Cantidad', 'quantity', { type: 'number', min: '1', max: '20', step: '1', value: '1', inputmode: 'numeric', required: '' })
    field(form, 'Nombre completo', 'fullName', { autocomplete: 'name', required: '' })
    field(form, 'Teléfono (WhatsApp)', 'phone', { type: 'tel', autocomplete: 'tel-national', inputmode: 'numeric', placeholder: '8 dígitos', required: '' })
    field(form, 'Dirección: casa, calle, colonia o aldea, número', 'address', { autocomplete: 'street-address', required: '' })
    field(form, 'Punto de referencia (recomendado)', 'reference', {})
    var row = el('div', { class: 'sof-row' })
    form.appendChild(row)
    row.appendChild(field(form, 'Departamento', 'departamento', { tag: 'select', placeholder: 'Elija su departamento', options: DEPARTAMENTOS }))
    row.appendChild(field(form, 'Municipio', 'municipio', { tag: 'select', placeholder: 'Elija su municipio' }))
    var departamento = form.querySelector('[name="departamento"]')
    departamento.addEventListener('change', function () {
      fill(form.querySelector('[name="municipio"]'), 'Elija su municipio', MUNICIPIOS[departamento.value] || [])
    })
    field(form, 'NIT (opcional)', 'nit', { maxlength: '20', placeholder: 'CF si no tiene' })
    form.appendChild(el('h3', {}, 'Pago'))
    form.appendChild(el('p', { class: 'sof-note' }, 'Todas las transacciones son seguras y están encriptadas.'))
    ;[['cod', 'Pago contra entrega', 'Paga en efectivo cuando recibe su pedido.'],
      ['card', 'Tarjeta de crédito o débito', 'Al confirmar por WhatsApp le enviamos su link de pago seguro.']].forEach(function (o, i) {
      var label = el('label', { class: 'sof-pay' })
      label.appendChild(el('input', Object.assign({ type: 'radio', name: 'payment', value: o[0] }, i ? {} : { checked: '' })))
      var copy = el('span')
      copy.appendChild(el('b', {}, o[1]))
      copy.appendChild(el('small', {}, o[2]))
      label.appendChild(copy)
      form.appendChild(label)
    })
    var hp = el('div', { class: 'sof-hp', 'aria-hidden': 'true' })
    hp.appendChild(el('input', { name: 'website', tabindex: '-1', autocomplete: 'off' }))
    form.appendChild(hp)
    var submit = el('button', { type: 'submit' }, 'Continuar por WhatsApp')
    var close = el('button', { type: 'button', class: 'sof-x' }, 'Cancelar')
    var msg = el('div', { role: 'status', 'aria-live': 'polite' })
    form.appendChild(submit)
    if (!mount) form.appendChild(close)
    form.appendChild(msg)
    box.appendChild(form)
    back.appendChild(box)
    if (!mount) {
      document.body.appendChild(back)
      form.querySelector('input').focus()
    }

    if (!mount) {
      function done() { back.remove(); document.removeEventListener('keydown', onKey); button.focus() }
      function onKey(e) { if (e.key === 'Escape') done() }
      document.addEventListener('keydown', onKey)
      close.addEventListener('click', done)
      back.addEventListener('click', function (e) { if (e.target === back) done() })
    }
    function show(kind, text) { msg.className = 'sof-msg ' + kind; msg.textContent = text }

    // One key per opened form: a retry after a network failure, or a double
    // click, is the same purchase and must not ask twice.
    var newKey = function () { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12) }
    var idempotencyKey = newKey()
    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var data = new FormData(form)
      var missing = ['fullName', 'phone', 'address', 'departamento', 'municipio'].filter(function (k) { return !String(data.get(k) || '').trim() })
      if (!cartItems && !variantId) return show('sof-err', 'Elija una variante del producto.')
      if (missing.length) return show('sof-err', 'Complete los campos obligatorios.')
      submit.disabled = true
      show('', 'Enviando…')
      fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: cartItems || [{ variantId: String(variantId), quantity: Number(data.get('quantity')) }],
          fullName: data.get('fullName'), phone: data.get('phone'), address: data.get('address'), reference: data.get('reference'),
          departamento: data.get('departamento'), municipio: data.get('municipio'), nit: data.get('nit'), payment: data.get('payment'), idempotencyKey: idempotencyKey, website: data.get('website'),
        }),
      }).then(function (r) { return r.json().catch(function () { return {} }).then(function (b) { return { ok: r.ok, body: b } }) })
        .then(function (res) {
          if (!res.ok) { submit.disabled = false; return show('sof-err', res.body.error || 'No pudimos enviar su pedido. Intente de nuevo.') }
          form.querySelectorAll('input,select,button[type=submit]').forEach(function (i) { i.disabled = true })
          close.textContent = 'Cerrar'
          // The purchase is saved on the server: the cart is no longer needed to recover it.
          if (cartItems) fetch('/cart/clear.js', { method: 'POST' }).catch(function () {})
          var ref = res.body.ref ? ' Su referencia es ' + res.body.ref + '.' : ''
          show('sof-ok', 'Guardamos su pedido.' + ref + ' Le enviamos el resumen al ' + String(data.get('phone')).trim() + ' por WhatsApp: acéptelo ahí con un SÍ.')
          submit.style.display = 'none'
          if (whatsapp) {
            // Opening the chat lets the summary arrive at once, and is the way
            // back if the message does not show up.
            var openChat = el('a', { class: 'sof-wa', target: '_blank', rel: 'noopener',
              href: 'https://wa.me/' + whatsapp + '?text=' + encodeURIComponent('Hola, hice un pedido en la tienda' + (res.body.ref ? ' (referencia ' + res.body.ref + ')' : '') + '. Quiero confirmarlo.') }, 'Abrir WhatsApp')
            msg.parentNode.insertBefore(openChat, msg.nextSibling)
          }
          var change = el('button', { type: 'button', class: 'sof-x' }, '¿No es su número? Cambiarlo')
          change.addEventListener('click', function () {
            form.querySelectorAll('input,select,button[type=submit]').forEach(function (i) { i.disabled = false })
            submit.style.display = ''
            form.querySelectorAll('.sof-wa').forEach(function (a) { a.remove() })
            change.remove()
            show('', '')
            // A corrected number is a new submit; the first one simply expires unanswered.
            idempotencyKey = newKey()
            form.querySelector('[name="phone"]').focus()
          })
          form.appendChild(change)
        })
        .catch(function () { submit.disabled = false; show('sof-err', 'Sin conexión. Intente de nuevo.') })
    })
  }

  document.head.appendChild(el('style', {}, css))

  // Order page: the cart's summary and the form, inline.
  var page = document.querySelector('[data-sandia-order-page]')
  if (page) {
    page.classList.add('sof-page')
    fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json() }).then(function (cart) {
      if (!cart.items.length) return page.appendChild(el('p', {}, 'Su carrito está vacío. Agregue un producto para hacer su pedido.'))
      var money = function (cents) { return 'Q' + (cents / 100).toLocaleString('es-GT', { minimumFractionDigits: 2 }) }
      var summary = el('ul', { class: 'sof-sum' })
      cart.items.forEach(function (i) {
        var li = el('li')
        li.appendChild(el('span', {}, i.quantity + ' x ' + i.product_title))
        li.appendChild(el('span', {}, money(i.final_line_price)))
        summary.appendChild(li)
      })
      var total = el('li', { class: 'sof-total' })
      total.appendChild(el('span', {}, 'Total · envío gratis'))
      total.appendChild(el('span', {}, money(cart.total_price)))
      summary.appendChild(total)
      open(page, cart.items.map(function (i) { return { variantId: String(i.variant_id), quantity: i.quantity } }), page, summary)
    }).catch(function () { page.appendChild(el('p', {}, 'No pudimos cargar su carrito. Recargue la página.')) })
  }
  document.addEventListener('click', function (e) {
    var button = e.target.closest && e.target.closest('[data-sandia-order]')
    if (!button) return
    e.preventDefault()
    if (!button.hasAttribute('data-sandia-cart')) return open(button)
    fetch('/cart.js', { headers: { Accept: 'application/json' } }).then(function (r) { return r.json() }).then(function (cart) {
      if (cart.items.length) open(button, cart.items.map(function (i) { return { variantId: String(i.variant_id), quantity: i.quantity } }))
    }).catch(function () {})
  })
})()
