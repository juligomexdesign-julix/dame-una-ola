// Dame una Ola — backend (Cloudflare Worker + D1)
// Rutas públicas:  /api/products, /api/images/:id, /api/checkout, /api/stripe/webhook, /api/account/*
// Rutas de la dueña: /admin y /api/admin/*  (protegidas con Cloudflare Access)

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const bad = (msg, status = 400) => json({ error: msg }, status);
const now = () => new Date().toISOString();

/* ---------------------------------------------------------------- esquema */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS products (
     id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT DEFAULT '',
     price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'usd', size_label TEXT DEFAULT 'One size (fits XL) · Baggy unisex',
     stock INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'draft', image_url TEXT DEFAULT '', image_alt TEXT DEFAULT '',
     ship_date TEXT DEFAULT '', sort INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS images (id INTEGER PRIMARY KEY AUTOINCREMENT, mime TEXT NOT NULL, data BLOB NOT NULL, created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS orders (
     id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE, email TEXT NOT NULL, name TEXT DEFAULT '', phone TEXT DEFAULT '',
     address_json TEXT DEFAULT '{}', items_json TEXT DEFAULT '[]', subtotal_cents INTEGER DEFAULT 0, shipping_cents INTEGER DEFAULT 0,
     total_cents INTEGER DEFAULT 0, currency TEXT DEFAULT 'usd', status TEXT NOT NULL DEFAULT 'paid', stripe_session_id TEXT UNIQUE,
     carrier TEXT DEFAULT '', tracking TEXT DEFAULT '', tracking_url TEXT DEFAULT '', shipped_at TEXT, note TEXT DEFAULT '',
     is_test INTEGER DEFAULT 0, created_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS orders_email ON orders(email)`,
  `CREATE TABLE IF NOT EXISTS login_tokens (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL, used INTEGER DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS templates (key TEXT PRIMARY KEY, subject TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, to_email TEXT, subject TEXT, html TEXT, kind TEXT,
     status TEXT, error TEXT DEFAULT '', created_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
];

const DEFAULT_TEMPLATES = {
  confirmation: {
    subject: "We got your pre-order 🌊 {{order_number}}",
    body: `Hi {{name}},

Thanks for riding this wave with us! Your pre-order {{order_number}} is confirmed.

{{items}}

Total: {{total}}

Pre-orders ship {{ship_date}}. We'll email you again with your tracking number as soon as your piece leaves the studio.

You can check your order anytime here: {{account_link}}

See you in the water,
Julia — Dame una Ola`,
  },
  shipped: {
    subject: "Your order is on its way 📦 {{order_number}}",
    body: `Hi {{name}},

Good news: your order {{order_number}} just left the studio.

{{items}}

Carrier: {{carrier}}
Tracking number: {{tracking}}
Track it here: {{tracking_link}}

Thanks for supporting a small surf brand born out of an endless obsession with waves.

Julia — Dame una Ola`,
  },
  login: {
    subject: "Your Dame una Ola login link",
    body: `Hi!

Click the link below to see your orders. It works once and expires in 30 minutes.

{{login_link}}

If you didn't ask for this, you can ignore this email.

Dame una Ola`,
  },
};

const SEED_PRODUCTS = [
  ["tie-dye-heart-sweatshirt", "Tie Dye Heart Sweatshirt", "Oversized fit. Purple tie-dye. A heart in the middle. Day or night, indoors or out. Wear it wherever, whenever.", 8500, 20, "/a/sweatshirt.webp", "Model wearing a purple tie-dye sweatshirt with a heart in the middle", 1],
  ["pink-chaos-surf-poncho", "Pink Chaos Surf Poncho", "Oversized fit. Pink and black tie-dye. Hood up, wetsuit off. Why bother picking an outfit when you've got a uniform?", 11000, 15, "/a/poncho.webp", "Model wearing a long pink and black tie-dye hooded surf poncho", 2],
  ["pastel-chaos-tie-dye-tee", "Pastel Chaos Tie Dye Tee", "Oversized fit. Purple, mint and aqua tie-dye. Buy it for your boyfriend. Wear it yourself.", 5500, 30, "/a/tee.webp", "Model wearing an oversized purple, mint and aqua tie-dye tee", 3],
];

let schemaReady = null;
async function ensureSchema(env) {
  if (!schemaReady) schemaReady = (async () => {
    await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM products").first();
    if (n === 0) {
      await env.DB.batch(SEED_PRODUCTS.map(([slug, name, desc, price, stock, img, alt, sort]) =>
        env.DB.prepare(`INSERT INTO products (slug,name,description,price_cents,stock,status,image_url,image_alt,ship_date,sort,created_at,updated_at)
                        VALUES (?,?,?,?,?,'active',?,?,'in early 2027',?,?,?)`).bind(slug, name, desc, price, stock, img, alt, sort, now(), now())));
    }
    for (const [key, t] of Object.entries(DEFAULT_TEMPLATES)) {
      await env.DB.prepare("INSERT OR IGNORE INTO templates (key,subject,body,updated_at) VALUES (?,?,?,?)").bind(key, t.subject, t.body, now()).run();
    }
  })().catch((e) => { schemaReady = null; throw e; });
  return schemaReady;
}

/* ---------------------------------------------------------------- utilidades */
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
async function sha256(s) { return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
const money = (cents, cur = "usd") => new Intl.NumberFormat("en-US", { style: "currency", currency: cur.toUpperCase() }).format((cents || 0) / 100);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const cleanEmail = (e) => String(e || "").trim().toLowerCase();
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const siteUrl = (env, req) => (env.SITE_URL || new URL(req.url).origin).replace(/\/$/, "");
function cookie(req, name) {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}
async function getSetting(env, key, fallback = "") {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return r ? r.value : fallback;
}

/* ---------------------------------------------------------------- Cloudflare Access (panel) */
let jwksCache = { at: 0, keys: [] };
async function verifyAccess(req, env) {
  if (env.DEV_ADMIN === "1") return { email: "dev@localhost" };       // solo para pruebas locales
  const team = (env.ACCESS_TEAM_DOMAIN || "").replace(/\/$/, ""), aud = env.ACCESS_AUD || "";
  if (!team || !aud) return null;                                       // sin configurar = cerrado
  const token = req.headers.get("cf-access-jwt-assertion") || cookie(req, "CF_Authorization");
  if (!token) return null;
  const [h, p, s] = token.split(".");
  if (!s) return null;
  const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  if (Date.now() - jwksCache.at > 3600_000 || !jwksCache.keys.find((k) => k.kid === header.kid)) {
    const r = await fetch(`${team}/cdn-cgi/access/certs`);
    jwksCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = jwksCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(s), enc.encode(`${h}.${p}`));
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!ok || !audOk || payload.iss !== team || payload.exp * 1000 < Date.now()) return null;
  return { email: payload.email };
}

/* ---------------------------------------------------------------- mails */
function renderTemplate(text, vars) { return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? "")); }
function emailHtml(bodyText, env, req) {
  const base = siteUrl(env, req);
  const paras = escapeHtml(bodyText).split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px;font:16px/1.55 Arial,Helvetica,sans-serif;color:#111">${p.replace(/\n/g, "<br>")
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#111;font-weight:bold">$1</a>')}</p>`).join("");
  return `<!doctype html><html><body style="margin:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;border:2px solid #111">
<tr><td align="center" style="padding:24px 24px 8px"><img src="${base}/a/email-logo.png" width="220" alt="Dame una Ola" style="display:block;width:220px;max-width:70%;height:auto"></td></tr>
<tr><td style="height:14px;background:repeating-linear-gradient(90deg,#F6C6DE 0 14px,#fff 14px 28px);border-block:2px solid #111;background-color:#F6C6DE"></td></tr>
<tr><td style="padding:28px 28px 12px">${paras}</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:2px solid #111;font:12px/1.5 Arial,Helvetica,sans-serif;color:#555">Dame una Ola · <a href="${base}" style="color:#555">dameunaola.com</a> · Instagram @dameunaola</td></tr>
</table></td></tr></table></body></html>`;
}
async function sendEmail(env, req, { to, kind, vars }) {
  const t = await env.DB.prepare("SELECT subject, body FROM templates WHERE key=?").bind(kind).first() || DEFAULT_TEMPLATES[kind];
  const subject = renderTemplate(t.subject, vars), html = emailHtml(renderTemplate(t.body, vars), env, req);
  let status = "logged", error = "";
  if (env.RESEND_API_KEY) {
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM || "Dame una Ola <onboarding@resend.dev>", to: [to], subject, html, reply_to: env.OWNER_EMAIL || undefined }),
      });
      if (r.ok) status = "sent"; else { status = "failed"; error = (await r.text()).slice(0, 300); }
    } catch (e) { status = "failed"; error = String(e).slice(0, 300); }
  }
  await env.DB.prepare("INSERT INTO outbox (to_email,subject,html,kind,status,error,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(to, subject, html, kind, status, error, now()).run();
  return status;
}
function orderVars(order, env, req) {
  const items = JSON.parse(order.items_json || "[]");
  return {
    name: (order.name || "").split(" ")[0] || "there",
    order_number: order.number,
    items: items.map((i) => `• ${i.qty} × ${i.name} (${i.size}) — ${money(i.price_cents * i.qty, order.currency)}`).join("\n"),
    total: money(order.total_cents, order.currency),
    ship_date: items[0]?.ship_date || "soon",
    carrier: order.carrier || "—",
    tracking: order.tracking || "—",
    tracking_link: order.tracking_url || "—",
    account_link: `${siteUrl(env, req)}/account`,
  };
}

/* ---------------------------------------------------------------- pedidos */
async function createOrder(env, req, { email, name, phone = "", address = {}, items, shipping_cents = 0, stripe_session_id = null, is_test = 0 }) {
  const subtotal = items.reduce((s, i) => s + i.price_cents * i.qty, 0);
  const res = await env.DB.prepare(`INSERT INTO orders (email,name,phone,address_json,items_json,subtotal_cents,shipping_cents,total_cents,currency,status,stripe_session_id,is_test,created_at)
     VALUES (?,?,?,?,?,?,?,?,'usd','paid',?,?,?)`)
    .bind(cleanEmail(email), name, phone, JSON.stringify(address), JSON.stringify(items), subtotal, shipping_cents, subtotal + shipping_cents, stripe_session_id, is_test, now()).run();
  const id = res.meta.last_row_id, number = `DUO-${1000 + id}`;
  await env.DB.prepare("UPDATE orders SET number=? WHERE id=?").bind(number, id).run();
  await env.DB.batch(items.map((i) => env.DB.prepare("UPDATE products SET stock = MAX(stock - ?, 0), updated_at=? WHERE id=?").bind(i.qty, now(), i.product_id)));
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
  await sendEmail(env, req, { to: order.email, kind: "confirmation", vars: orderVars(order, env, req) });
  return order;
}

/* ---------------------------------------------------------------- Stripe */
async function stripe(env, path, params) {
  const body = new URLSearchParams();
  const add = (prefix, val) => {
    if (val === undefined || val === null) return;
    if (typeof val === "object") Object.entries(val).forEach(([k, v]) => add(prefix ? `${prefix}[${k}]` : k, v));
    else body.append(prefix, String(val));
  };
  add("", params);
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST", headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "content-type": "application/x-www-form-urlencoded" }, body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || "Stripe error");
  return data;
}
async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
  const t = parts.t, sigs = header.split(",").filter((x) => x.startsWith("v1=")).map((x) => x.slice(3));
  if (!t || !sigs.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === hex.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ hex.charCodeAt(i)), 0) === 0);
}

/* ---------------------------------------------------------------- sesiones de cliente */
async function customerEmail(req, env) {
  const t = cookie(req, "duo_session");
  if (!t) return null;
  const r = await env.DB.prepare("SELECT email, expires_at FROM sessions WHERE token_hash=?").bind(await sha256(t)).first();
  return r && r.expires_at > now() ? r.email : null;
}

/* ---------------------------------------------------------------- router */
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname, method = req.method;
    try {
      // Panel: la página y su API pasan siempre por Access
      if (path === "/admin" || path.startsWith("/admin/") || path.startsWith("/api/admin")) {
        const who = await verifyAccess(req, env);
        if (!who) {
          const msg = (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) ? "Unauthorized" : "Admin is locked: Cloudflare Access is not configured yet.";
          return path.startsWith("/api/") ? bad(msg, 401) : new Response(msg, { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
        await ensureSchema(env);
        return await adminApi(req, env, url, who);
      }
      if (path.startsWith("/api/")) { await ensureSchema(env); return await publicApi(req, env, url, ctx); }
      if (path === "/account/verify") { await ensureSchema(env); return await verifyLogin(req, env, url); }
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return bad("Server error: " + (e.message || e), 500);
    }
  },
};

/* ---------------------------------------------------------------- API pública */
async function publicApi(req, env, url, ctx) {
  const path = url.pathname, method = req.method;

  if (path === "/api/products" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT id,slug,name,description,price_cents,currency,size_label,stock,status,image_url,image_alt,ship_date
      FROM products WHERE status='active' ORDER BY sort, id`).all();
    return json({ products: results, checkout: !!env.STRIPE_SECRET_KEY }, 200, { "cache-control": "no-store" });
  }

  let m;
  if ((m = path.match(/^\/api\/images\/(\d+)$/)) && method === "GET") {
    const img = await env.DB.prepare("SELECT mime, data FROM images WHERE id=?").bind(m[1]).first();
    if (!img) return bad("Not found", 404);
    return new Response(new Uint8Array(img.data), { headers: { "content-type": img.mime, "cache-control": "public, max-age=31536000, immutable" } });
  }

  if (path === "/api/checkout" && method === "POST") {
    if (!env.STRIPE_SECRET_KEY) return bad("Pre-orders open soon. Checkout isn't live yet.", 503);
    const { product_id, qty = 1 } = await req.json();
    const p = await env.DB.prepare("SELECT * FROM products WHERE id=? AND status='active'").bind(product_id).first();
    if (!p) return bad("Product not found", 404);
    const q = Math.max(1, Math.min(Number(qty) || 1, 5));
    if (p.stock < q) return bad("Sorry, this one is sold out.", 409);
    const base = siteUrl(env, req);
    const countries = (env.SHIP_COUNTRIES || "US").split(",").map((c) => c.trim()).filter(Boolean);
    const session = await stripe(env, "checkout/sessions", {
      mode: "payment",
      success_url: `${base}/account?checkout=success`,
      cancel_url: `${base}/#shop`,
      line_items: { 0: { quantity: q, adjustable_quantity: { enabled: true, minimum: 1, maximum: Math.min(p.stock, 5) },
        price_data: { currency: p.currency, unit_amount: p.price_cents,
          product_data: { name: p.name, description: `${p.size_label} · Pre-order, ships ${p.ship_date || "soon"}`,
            images: p.image_url ? { 0: p.image_url.startsWith("http") ? p.image_url : base + p.image_url } : undefined } } } },
      shipping_address_collection: { allowed_countries: Object.fromEntries(countries.map((c, i) => [i, c])) },
      phone_number_collection: { enabled: true },
      metadata: { product_id: String(p.id) },
    });
    return json({ url: session.url });
  }

  if (path === "/api/stripe/webhook" && method === "POST") {
    const payload = await req.text();
    if (!(await verifyStripeSignature(payload, req.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET))) return bad("Bad signature", 400);
    const event = JSON.parse(payload);
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const exists = await env.DB.prepare("SELECT id FROM orders WHERE stripe_session_id=?").bind(s.id).first();
      if (!exists) {
        const p = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(s.metadata?.product_id).first();
        const qty = p ? Math.max(1, Math.round((s.amount_subtotal || p.price_cents) / p.price_cents)) : 1;
        const ship = s.collected_information?.shipping_details || s.shipping_details || {};
        await createOrder(env, req, {
          email: s.customer_details?.email, name: ship.name || s.customer_details?.name || "", phone: s.customer_details?.phone || "",
          address: ship.address || s.customer_details?.address || {},
          items: [{ product_id: p?.id, name: p?.name || "Item", size: p?.size_label || "", qty, price_cents: p?.price_cents || s.amount_subtotal, ship_date: p?.ship_date || "" }],
          shipping_cents: s.total_details?.amount_shipping || 0, stripe_session_id: s.id, is_test: s.livemode ? 0 : 1,
        });
      }
    }
    return json({ received: true });
  }

  if (path === "/api/account/login" && method === "POST") {
    const { email } = await req.json();
    const e = cleanEmail(email);
    if (!validEmail(e)) return bad("Enter a valid email.");
    const t = randomToken();
    await env.DB.prepare("INSERT INTO login_tokens (token_hash,email,expires_at) VALUES (?,?,?)")
      .bind(await sha256(t), e, new Date(Date.now() + 30 * 60_000).toISOString()).run();
    await sendEmail(env, req, { to: e, kind: "login", vars: { login_link: `${siteUrl(env, req)}/account/verify?token=${t}` } });
    return json({ ok: true });
  }

  if (path === "/api/account/me" && method === "GET") {
    const email = await customerEmail(req, env);
    if (!email) return json({ email: null });
    const { results } = await env.DB.prepare(`SELECT number,status,items_json,total_cents,currency,carrier,tracking,tracking_url,shipped_at,created_at
      FROM orders WHERE email=? ORDER BY id DESC`).bind(email).all();
    return json({ email, orders: results.map((o) => ({ ...o, items: JSON.parse(o.items_json), items_json: undefined })) }, 200, { "cache-control": "no-store" });
  }

  if (path === "/api/account/logout" && method === "POST") {
    const t = cookie(req, "duo_session");
    if (t) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await sha256(t)).run();
    return json({ ok: true }, 200, { "set-cookie": "duo_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
  }

  return bad("Not found", 404);
}

async function verifyLogin(req, env, url) {
  const t = url.searchParams.get("token") || "";
  const h = await sha256(t);
  const row = await env.DB.prepare("SELECT email, expires_at, used FROM login_tokens WHERE token_hash=?").bind(h).first();
  if (!row || row.used || row.expires_at < now()) return Response.redirect(`${url.origin}/account?login=expired`, 302);
  await env.DB.prepare("UPDATE login_tokens SET used=1 WHERE token_hash=?").bind(h).run();
  const s = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash,email,expires_at) VALUES (?,?,?)")
    .bind(await sha256(s), row.email, new Date(Date.now() + 30 * 86400_000).toISOString()).run();
  return new Response(null, { status: 302, headers: { location: "/account", "set-cookie": `duo_session=${s}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax` } });
}

/* ---------------------------------------------------------------- API del panel */
const PRODUCT_FIELDS = ["name", "slug", "description", "price_cents", "size_label", "stock", "status", "image_url", "image_alt", "ship_date", "sort"];

async function adminApi(req, env, url, who) {
  const path = url.pathname, method = req.method;
  let m;

  if (path === "/api/admin/status") {
    return json({
      you: who.email,
      integrations: {
        database: true,
        access: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD),
        stripe: !!env.STRIPE_SECRET_KEY, stripe_mode: (env.STRIPE_SECRET_KEY || "").startsWith("sk_live") ? "live" : "test",
        stripe_webhook: !!env.STRIPE_WEBHOOK_SECRET,
        email: !!env.RESEND_API_KEY, mail_from: env.MAIL_FROM || "",
      },
      ship_countries: env.SHIP_COUNTRIES || "US",
    });
  }

  if (path === "/api/admin/summary") {
    const q = (s, ...b) => env.DB.prepare(s).bind(...b).first();
    const [toShip, shipped, revenue, lowStock, products] = await Promise.all([
      q("SELECT COUNT(*) n FROM orders WHERE status='paid'"),
      q("SELECT COUNT(*) n FROM orders WHERE status IN ('shipped','delivered')"),
      q("SELECT COALESCE(SUM(total_cents),0) n, COUNT(*) c FROM orders WHERE status NOT IN ('cancelled','refunded')"),
      env.DB.prepare("SELECT id,name,stock FROM products WHERE status='active' AND stock<=5 ORDER BY stock").all(),
      q("SELECT COUNT(*) n, COALESCE(SUM(stock),0) s FROM products WHERE status='active'"),
    ]);
    const { results: recent } = await env.DB.prepare("SELECT id,number,name,email,total_cents,status,is_test,created_at FROM orders ORDER BY id DESC LIMIT 5").all();
    return json({ to_ship: toShip.n, shipped: shipped.n, revenue_cents: revenue.n, orders: revenue.c, low_stock: lowStock.results, active_products: products.n, units_in_stock: products.s, recent });
  }

  // productos
  if (path === "/api/admin/products" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT p.*, (SELECT COALESCE(SUM(json_extract(j.value,'$.qty')),0) FROM orders o, json_each(o.items_json) j
       WHERE json_extract(j.value,'$.product_id')=p.id AND o.status NOT IN ('cancelled','refunded')) AS sold FROM products p ORDER BY sort, id`).all();
    return json({ products: results });
  }
  if (path === "/api/admin/products" && method === "POST") {
    const b = await req.json();
    if (!b.name) return bad("Products need a name.");
    const slug = slugify(b.slug || b.name);
    const r = await env.DB.prepare(`INSERT INTO products (slug,name,description,price_cents,size_label,stock,status,image_url,image_alt,ship_date,sort,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(slug, b.name, b.description || "", Math.round(b.price_cents || 0), b.size_label || "One size (fits XL) · Baggy unisex",
      Math.max(0, Math.round(b.stock || 0)), b.status || "draft", b.image_url || "", b.image_alt || "", b.ship_date || "", Number(b.sort || 99), now(), now()).run();
    return json({ id: r.meta.last_row_id }, 201);
  }
  if ((m = path.match(/^\/api\/admin\/products\/(\d+)$/))) {
    if (method === "PUT") {
      const b = await req.json();
      const sets = [], vals = [];
      for (const f of PRODUCT_FIELDS) if (f in b) {
        let v = b[f];
        if (f === "slug") v = slugify(v);
        if (["price_cents", "stock", "sort"].includes(f)) v = Math.max(0, Math.round(Number(v) || 0));
        sets.push(`${f}=?`); vals.push(v);
      }
      if (!sets.length) return bad("Nothing to update.");
      await env.DB.prepare(`UPDATE products SET ${sets.join(",")}, updated_at=? WHERE id=?`).bind(...vals, now(), m[1]).run();
      return json({ ok: true });
    }
    if (method === "DELETE") {
      await env.DB.prepare("UPDATE products SET status='archived', updated_at=? WHERE id=?").bind(now(), m[1]).run();
      return json({ ok: true });
    }
  }
  if (path === "/api/admin/images" && method === "POST") {
    const mime = req.headers.get("content-type") || "image/webp";
    if (!/^image\/(webp|jpeg|png)$/.test(mime)) return bad("Use a JPG, PNG or WebP image.");
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 900_000) return bad("That image is too large (max 900 KB).");
    const r = await env.DB.prepare("INSERT INTO images (mime,data,created_at) VALUES (?,?,?)").bind(mime, buf, now()).run();
    return json({ url: `/api/images/${r.meta.last_row_id}` }, 201);
  }

  // pedidos
  if (path === "/api/admin/orders" && method === "GET") {
    const st = url.searchParams.get("status");
    const sql = `SELECT * FROM orders ${st && st !== "all" ? "WHERE status=?" : ""} ORDER BY id DESC LIMIT 200`;
    const { results } = await (st && st !== "all" ? env.DB.prepare(sql).bind(st) : env.DB.prepare(sql)).all();
    return json({ orders: results.map((o) => ({ ...o, items: JSON.parse(o.items_json), address: JSON.parse(o.address_json) })) });
  }
  if ((m = path.match(/^\/api\/admin\/orders\/(\d+)\/ship$/)) && method === "POST") {
    const b = await req.json();
    await env.DB.prepare("UPDATE orders SET status='shipped', carrier=?, tracking=?, tracking_url=?, shipped_at=? WHERE id=?")
      .bind(b.carrier || "", b.tracking || "", b.tracking_url || "", now(), m[1]).run();
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(m[1]).first();
    let mail = null;
    if (b.notify !== false) mail = await sendEmail(env, req, { to: order.email, kind: "shipped", vars: orderVars(order, env, req) });
    return json({ ok: true, mail });
  }
  if ((m = path.match(/^\/api\/admin\/orders\/(\d+)$/)) && method === "PUT") {
    const b = await req.json();
    const allowed = ["paid", "shipped", "delivered", "cancelled", "refunded"];
    if (b.status && !allowed.includes(b.status)) return bad("Invalid status.");
    if (b.status) await env.DB.prepare("UPDATE orders SET status=? WHERE id=?").bind(b.status, m[1]).run();
    if ("note" in b) await env.DB.prepare("UPDATE orders SET note=? WHERE id=?").bind(b.note, m[1]).run();
    return json({ ok: true });
  }
  if (path === "/api/admin/test-order" && method === "POST") {
    const b = await req.json();
    const p = await env.DB.prepare("SELECT * FROM products WHERE id=?").bind(b.product_id).first();
    if (!p) return bad("Choose a product.");
    const e = cleanEmail(b.email || who.email);
    if (!validEmail(e)) return bad("Invalid email.");
    const order = await createOrder(env, req, {
      email: e, name: b.name || "Test Customer",
      address: { line1: "123 Ocean Ave", city: "Florianópolis", state: "SC", postal_code: "88000-000", country: "BR" },
      items: [{ product_id: p.id, name: p.name, size: p.size_label, qty: 1, price_cents: p.price_cents, ship_date: p.ship_date }],
      is_test: 1,
    });
    return json({ order }, 201);
  }

  // mails
  if (path === "/api/admin/templates" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM templates ORDER BY key").all();
    return json({ templates: results, placeholders: ["name", "order_number", "items", "total", "ship_date", "carrier", "tracking", "tracking_link", "account_link", "login_link"] });
  }
  if ((m = path.match(/^\/api\/admin\/templates\/(\w+)$/)) && method === "PUT") {
    const b = await req.json();
    if (!b.subject || !b.body) return bad("Subject and message are required.");
    await env.DB.prepare("INSERT INTO templates (key,subject,body,updated_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET subject=excluded.subject, body=excluded.body, updated_at=excluded.updated_at")
      .bind(m[1], b.subject, b.body, now()).run();
    return json({ ok: true });
  }
  if ((m = path.match(/^\/api\/admin\/templates\/(\w+)\/reset$/)) && method === "POST") {
    const d = DEFAULT_TEMPLATES[m[1]];
    if (!d) return bad("Not found.");
    await env.DB.prepare("UPDATE templates SET subject=?, body=?, updated_at=? WHERE key=?").bind(d.subject, d.body, now(), m[1]).run();
    return json({ ok: true });
  }
  if (path === "/api/admin/preview" && method === "POST") {
    const b = await req.json();
    const sample = { name: "Julia", order_number: "DUO-1001", items: "• 1 × Pink Chaos Surf Poncho (One size) — $110.00", total: "$110.00",
      ship_date: "in early 2027", carrier: "Correios", tracking: "AA123456789BR", tracking_link: "https://rastreamento.correios.com.br",
      account_link: `${siteUrl(env, req)}/account`, login_link: `${siteUrl(env, req)}/account/verify?token=example` };
    return json({ subject: renderTemplate(b.subject || "", sample), html: emailHtml(renderTemplate(b.body || "", sample), env, req) });
  }
  if (path === "/api/admin/outbox" && method === "GET") {
    const { results } = await env.DB.prepare("SELECT id,to_email,subject,kind,status,error,created_at FROM outbox ORDER BY id DESC LIMIT 50").all();
    return json({ outbox: results });
  }
  if ((m = path.match(/^\/api\/admin\/outbox\/(\d+)$/)) && method === "GET") {
    const r = await env.DB.prepare("SELECT * FROM outbox WHERE id=?").bind(m[1]).first();
    return r ? new Response(r.html, { headers: { "content-type": "text/html; charset=utf-8" } }) : bad("Not found.", 404);
  }

  return bad("Not found", 404);
}
