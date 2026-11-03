# Dame una Ola — sitio web

Sitio estático (HTML + imágenes) publicado con **Cloudflare Workers** desde **GitHub**.

```
dameunaola/
├── public/            ← todo lo que se publica
│   ├── index.html     ← la página (Home, About, Shop, Contact)
│   └── a/             ← imágenes
├── wrangler.jsonc     ← configuración de Cloudflare
└── README.md
```

## 1. Subir a GitHub
1. Entrá a github.com → **New repository** → nombre `dameunaola` → **Create**.
2. En la página del repo vacío, hacé clic en **uploading an existing file**.
3. Arrastrá **todo el contenido** de esta carpeta (la carpeta `public`, `wrangler.jsonc`, `README.md` y `.gitignore`) → **Commit changes**.

## 2. Publicar en Cloudflare
1. En dash.cloudflare.com → **Workers & Pages** → **Create** → **Import a repository**.
2. Conectá tu cuenta de GitHub y elegí `dameunaola`.
3. Dejá el comando de build vacío y el de deploy como `npx wrangler deploy`. Guardá y desplegá.
4. Cada vez que cambies algo en GitHub, Cloudflare vuelve a publicar solo.

## 3. Dominio dameunaola.com
1. Cloudflare → **Domain Registration** → **Register Domains** → buscá `dameunaola.com` y compralo.
2. En tu Worker → **Settings** → **Domains & Routes** → **Add** → **Custom domain** → `dameunaola.com` (y también `www.dameunaola.com`).

## 4. Conectar formulario, chat y pagos
Abrí `public/index.html`, buscá el bloque **CONFIGURACIÓN** (cerca del final) y completá:

| Campo | De dónde sale |
|---|---|
| `web3formsKey` | web3forms.com → poné `juligomexdesign@gmail.com` → te llega la Access Key por mail |
| `crispWebsiteId` | crisp.chat → crear cuenta gratis → Settings → Website Settings → Setup → **Website ID** |
| `stripeLinks` | Stripe → Product catalog → crear cada producto → **Create payment link** → copiar el link |

Mientras un campo esté vacío, esa parte funciona en modo demo (no envía nada / chat automático / botón lleva al formulario).
