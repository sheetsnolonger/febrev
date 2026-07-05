const express = require("express");
const session = require("express-session");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const PAYPAL_BASE =
  process.env.PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.set("view engine", "ejs");

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "febrev-dev-secret",
    resave: false,
    saveUninitialized: true
  })
);

const products = [
{
  id: 1,
  name: "medium black handmade stuffed crochet kitty",
  price: 20,
  image: "/images/kittycrochet1.jpg",
  description: "this crocheted kitty is not only a stuffed animal, but a friend. crocheted with black yarn, white button eyes, and a white X mouth. made with love.",
  etsy: "https://www.etsy.com/"
}


async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      paypal_order_id TEXT UNIQUE,
      customer_email TEXT,
      customer_name TEXT,
      shipping_name TEXT,
      shipping_address TEXT,
      total INTEGER,
      status TEXT DEFAULT 'paid',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id SERIAL PRIMARY KEY,
      order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
      product_name TEXT,
      quantity INTEGER,
      price INTEGER
    )
  `);
}

initDb().catch(err => console.error("database init error:", err));

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function cartCount(req) {
  return getCart(req).reduce((sum, item) => sum + item.quantity, 0);
}

function cartTotal(cart) {
  return cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
}

async function getPayPalAccessToken() {
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  });

  const data = await response.json();

  if (!response.ok) {
    console.error(data);
    throw new Error("could not get paypal access token");
  }

  return data.access_token;
}

app.get("/", (req, res) => {
  res.render("index", {
    title: "feb & rev",
    products,
    cartCount: cartCount(req)
  });
});

app.get("/product/:id", (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));

  if (!product) return res.status(404).send("product not found");

  res.render("product", {
    title: product.name,
    product,
    cartCount: cartCount(req)
  });
});

app.post("/cart/add/:id", (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));

  if (!product) return res.status(404).send("product not found");

  const cart = getCart(req);
  const existing = cart.find(item => item.id === product.id);

  if (existing) {
    existing.quantity += 1;
  } else {
    cart.push({
      id: product.id,
      name: product.name,
      price: product.price,
      image: product.image,
      quantity: 1
    });
  }

  res.redirect("/cart");
});

app.get("/cart", (req, res) => {
  const cart = getCart(req);
  const total = cartTotal(cart);

  res.render("cart", {
    title: "cart",
    cart,
    total,
    cartCount: cartCount(req),
    paypalClientId: process.env.PAYPAL_CLIENT_ID || ""
  });
});

app.post("/cart/remove/:id", (req, res) => {
  req.session.cart = getCart(req).filter(item => item.id !== Number(req.params.id));
  res.redirect("/cart");
});

app.post("/api/paypal/create-order", async (req, res) => {
  const cart = getCart(req);

  if (cart.length === 0) {
    return res.status(400).json({ error: "cart is empty" });
  }

  const subtotal = cartTotal(cart);
  const shipping = 5;
  const total = subtotal + shipping;

  try {
    const accessToken = await getPayPalAccessToken();

    const response = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            description: "feb & rev order",
            amount: {
              currency_code: "USD",
              value: total.toFixed(2),
              breakdown: {
                item_total: {
                  currency_code: "USD",
                  value: subtotal.toFixed(2)
                },
                shipping: {
                  currency_code: "USD",
                  value: shipping.toFixed(2)
                }
              }
            },
            items: cart.map(item => ({
              name: item.name,
              quantity: String(item.quantity),
              unit_amount: {
                currency_code: "USD",
                value: item.price.toFixed(2)
              }
            }))
          }
        ],
        application_context: {
          shipping_preference: "GET_FROM_FILE"
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: "paypal create order failed" });
    }

    res.json({ id: data.id });
  } catch (err) {
    console.error("paypal create order error:", err);
    res.status(500).json({ error: "paypal create order error" });
  }
});

app.post("/api/paypal/capture-order/:orderId", async (req, res) => {
  const cart = getCart(req);

  try {
    const accessToken = await getPayPalAccessToken();

    const response = await fetch(
      `${PAYPAL_BASE}/v2/checkout/orders/${req.params.orderId}/capture`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(data);
      return res.status(500).json({ error: "paypal capture failed" });
    }

    const purchaseUnit = data.purchase_units?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];

    if (capture?.status === "COMPLETED") {
      const payer = data.payer || {};
      const shipping = purchaseUnit.shipping || {};
      const address = shipping.address || {};

      const shippingAddress = [
        address.address_line_1 || "",
        address.address_line_2 || "",
        `${address.admin_area_2 || ""}, ${address.admin_area_1 || ""} ${address.postal_code || ""}`,
        address.country_code || ""
      ]
        .filter(line => line.trim() !== "")
        .join("\n");

      const existing = await pool.query(
        "SELECT id FROM orders WHERE paypal_order_id = $1",
        [data.id]
      );

      if (existing.rows.length === 0) {
        const orderResult = await pool.query(
          `
          INSERT INTO orders (
            paypal_order_id,
            customer_email,
            customer_name,
            shipping_name,
            shipping_address,
            total,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
          `,
          [
            data.id,
            payer.email_address || "",
            `${payer.name?.given_name || ""} ${payer.name?.surname || ""}`.trim(),
            shipping.name?.full_name || "",
            shippingAddress,
            Math.round(Number(capture.amount.value) * 100),
            "paid"
          ]
        );

        const orderId = orderResult.rows[0].id;

        for (const item of cart) {
          await pool.query(
            `
            INSERT INTO order_items (
              order_id,
              product_name,
              quantity,
              price
            )
            VALUES ($1, $2, $3, $4)
            `,
            [orderId, item.name, item.quantity, item.price]
          );
        }
      }

      req.session.cart = [];
    }

    res.json(data);
  } catch (err) {
    console.error("paypal capture error:", err);
    res.status(500).json({ error: "paypal capture error" });
  }
});

app.get("/success", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>order complete | feb & rev</title>
      <link rel="stylesheet" href="/style.css">
    </head>
    <body>
      <header>
        <h1>feb & rev</h1>
        <nav>
          <a href="/">shop</a>
          <a href="/cart">cart</a>
        </nav>
      </header>
      <main>
        <section class="hero">
          <h2>order complete</h2>
          <p>thank you for shopping feb & rev.</p>
          <a class="button" href="/">back to shop</a>
        </section>
      </main>
    </body>
    </html>
  `);
});

app.get("/orders", async (req, res) => {
  try {
    const orders = await pool.query(`
      SELECT * FROM orders
      ORDER BY created_at DESC
    `);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>orders | feb & rev</title>
        <link rel="stylesheet" href="/style.css">
      </head>
      <body>
        <header>
          <h1>orders</h1>
          <nav>
            <a href="/">shop</a>
          </nav>
        </header>
        <main>
          ${orders.rows.map(order => `
            <section class="hero">
              <h2>order #${order.id}</h2>
              <p><b>email:</b> ${order.customer_email}</p>
              <p><b>name:</b> ${order.customer_name}</p>
              <p><b>shipping:</b><br>${String(order.shipping_address || "").replace(/\n/g, "<br>")}</p>
              <p><b>total:</b> $${(order.total / 100).toFixed(2)}</p>
              <p><b>status:</b> ${order.status}</p>
            </section>
          `).join("")}
        </main>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("orders error:", err);
    res.status(500).send("orders error");
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`feb & rev running on port ${PORT}`);
});
