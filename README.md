# Dame una Ola — tienda

Tienda de prueba hecha con **Cloudflare Workers + D1** y publicada desde **GitHub**.

```
dame-una-ola/
├── public/              ← lo que ve la gente
│   ├── index.html       ← tienda (Home, About, Shop, Contact)
│   ├── account/         ← "Account": el cliente ve sus pedidos
│   ├── admin/           ← panel interno (protegido)
│   └── a/               ← imágenes
├── src/worker.js        ← backend: productos, pedidos, mails, pagos
└── wrangler.jsonc       ← configuración de Cloudflare
```

## Cómo funciona
- **Base de datos (D1):** productos, stock, pedidos, clientes y plantillas de mail. Se crea sola en el primer deploy.
- **Panel `/admin`:** stock, productos nuevos, pedidos, "marcar como enviado", textos de los mails, checklist de integraciones.
- **Cuenta `/account`:** el cliente pone su email, recibe un link de un solo uso y ve sus pedidos con el estado y el tracking.
- **Pagos:** Stripe Checkout. Al pagar, Stripe avisa al sitio (webhook), se crea el pedido, baja el stock y sale el mail de confirmación.
- **Mails:** Resend. Mientras no esté conectado, los mails se guardan en el panel (pestaña Mails) pero no se envían.

## Configuración pendiente (en orden)

### 1. Proteger el panel con Cloudflare Access
1. Cloudflare → **Zero Trust** (elegí el plan Free si lo pide) → **Access** → **Applications** → **Add an application** → **Self-hosted**.
2. Nombre: `Dame una Ola Admin`. Agregá dos destinos: dominio `dameunaola.com` con path `admin`, y `dameunaola.com` con path `api/admin`.
3. Política: **Allow** → Include → **Emails** → `juligomexdesign@gmail.com`.
4. Guardá. En la app creada copiá el **Application Audience (AUD) Tag**.
5. En Zero Trust → **Settings** → **Custom Pages** (o Team name) copiá tu **team domain**: `https://TU-EQUIPO.cloudflareaccess.com`.
6. Pegá ambos en `wrangler.jsonc` → `ACCESS_TEAM_DOMAIN` y `ACCESS_AUD` (o pasáselos a Claude).

Hasta que esto esté, `/admin` responde "locked" a todo el mundo (es a propósito).

### 2. Mails (Resend)
1. Cuenta gratis en resend.com → **Domains** → agregar `dameunaola.com` (se conecta con Cloudflare DNS).
2. **API Keys** → crear una.
3. Cloudflare → Workers & Pages → dameunaola → **Settings → Variables and Secrets** → **Add** → tipo **Secret** → `RESEND_API_KEY`.

### 3. Pagos (Stripe, modo prueba)
1. Cuenta en stripe.com. Activá el **Test mode**.
2. Developers → API keys → copiá la **Secret key** (`sk_test_…`) → secreto `STRIPE_SECRET_KEY` en Cloudflare.
3. Developers → Webhooks → **Add endpoint** → `https://dameunaola.com/api/stripe/webhook`, evento `checkout.session.completed` → copiá el **Signing secret** (`whsec_…`) → secreto `STRIPE_WEBHOOK_SECRET`.
4. Para probar, pagá con la tarjeta `4242 4242 4242 4242`, cualquier fecha futura y cualquier CVC.

## Probar en tu compu (opcional)
```
npx wrangler dev --var DEV_ADMIN:1
```
`DEV_ADMIN` abre el panel sin login **solo en local**. Nunca lo pongas en `wrangler.jsonc`.
