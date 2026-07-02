const express = require("express");
const session = require("express-session");
const Stripe = require("stripe");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
});

app.set("view engine", "ejs");

const products = [
  {
    id: 1,
    name: "cat crochet doll 'fangs'",
    price: 40,
    image: "https://pyxis.nymag.com/v1/imgs/4ba/176/b5cb8c6fc4c22054ebde2816426921dccf-31-black-kitten.rsquare.w400.jpg",
    description: "hand crocheted by feb herself! :-)"
  },

];

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      stripe_session_id TEXT UNIQUE,
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

initDb().catch(err => {
  console.error("database init error:", err);
});

/*
  IMPORTANT:
  this webhook route must stay BEFORE:
  app.use(express.urlencoded(...))
*/
app.post("/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];

    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("stripe webhook signature error:", err.message);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const stripeSession = event.data.object;

    try {
      const cart = JSON.parse(stripeSession.metadata.cart || "[]");

      const shipping = stripeSession.shipping_details || {};
      const address = shipping.address || {};

      const shippingAddress = [
        address.line1 || "",
        address.line2 || "",
        `${address.city || ""}, ${address.state || ""} ${address.postal_code || ""}`,
        address.country || ""
      ]
        .filter(line => line.trim() !== "")
        .join("\n");

      const existing = await pool.query(
        "SELECT id FROM orders WHERE stripe_session_id = $1",
        [stripeSession.id]
      );

      if (existing.rows.length === 0) {
        const orderResult = await pool.query(
          `
          INSERT INTO orders (
            stripe_session_id,
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
            stripeSession.id,
            stripeSession.customer_details?.email || "",
            stripeSession.customer_details?.name || "",
            shipping.name || "",
            shippingAddress,
            stripeSession.amount_total || 0,
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

        console.log("saved order:", orderId);
      }
    } catch (err) {
      console.error("order save error:", err);
      return res.sendStatus(500);
    }
  }

  res.sendStatus(200);
});

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "febrev-dev-secret",
    resave: false,
    saveUninitialized: true
  })
);

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function cartCount(req) {
  return getCart(req).reduce((sum, item) => sum + item.quantity, 0);
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

  if (!product) {
    return res.status(404).send("product not found");
  }

  res.render("product", {
    title: product.name,
    product,
    cartCount: cartCount(req)
  });
});

app.post("/cart/add/:id", (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));

  if (!product) {
    return res.status(404).send("product not found");
  }

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
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  res.render("cart", {
    title: "cart",
    cart,
    total,
    cartCount: cartCount(req)
  });
});

app.post("/cart/remove/:id", (req, res) => {
  req.session.cart = getCart(req).filter(item => item.id !== Number(req.params.id));
  res.redirect("/cart");
});

app.post("/create-checkout-session", async (req, res) => {
  const cart = getCart(req);

  if (cart.length === 0) {
    return res.redirect("/cart");
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",

      line_items: cart.map(item => ({
        price_data: {
          currency: "usd",
          product_data: {
            name: item.name,
            images: [item.image]
          },
          unit_amount: item.price * 100
        },
        quantity: item.quantity
      })),

      metadata: {
        cart: JSON.stringify(cart)
      },

      shipping_address_collection: {
        allowed_countries: ["US"]
      },

      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: 500,
              currency: "usd"
            },
            display_name: "standard shipping",
            delivery_estimate: {
              minimum: {
                unit: "business_day",
                value: 3
              },
              maximum: {
                unit: "business_day",
                value: 7
              }
            }
          }
        }
      ],

      success_url: `${process.env.DOMAIN || "http://localhost:3000"}/success`,
      cancel_url: `${process.env.DOMAIN || "http://localhost:3000"}/cart`
    });

    res.redirect(checkoutSession.url);
  } catch (err) {
    console.error("checkout error:", err);
    res.status(500).send("checkout error");
  }
});

app.get("/success", (req, res) => {
  req.session.cart = [];

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
              <p><b>shipping:</b><br>${order.shipping_address.replace(/\n/g, "<br>")}</p>
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
