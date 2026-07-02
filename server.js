const express = require("express");
const session = require("express-session");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");

app.use(express.urlencoded({ extended: true }));
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
    name: "feb & rev shirt",
    price: 25,
    image: "https://placehold.co/500x500?text=feb+%26+rev+shirt",
    description: "a simple feb & rev shop shirt."
  },
  {
    id: 2,
    name: "feb & rev sticker pack",
    price: 8,
    image: "https://placehold.co/500x500?text=stickers",
    description: "stickers for laptops, phones, and notebooks."
  },
  {
    id: 3,
    name: "feb & rev tote bag",
    price: 18,
    image: "https://placehold.co/500x500?text=tote+bag",
    description: "a cute everyday tote bag."
  }
];

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

app.get("/checkout", (req, res) => {
  const cart = getCart(req);
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

  res.render("checkout", {
    title: "checkout",
    cart,
    total,
    cartCount: cartCount(req)
  });
});

app.post("/create-checkout-session", async (req, res) => {
  const cart = getCart(req);

  if (cart.length === 0) {
    return res.redirect("/cart");
  }

  try {
    const session = await stripe.checkout.sessions.create({
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
              minimum: { unit: "business_day", value: 3 },
              maximum: { unit: "business_day", value: 7 }
            }
          }
        }
      ],

      success_url: `${process.env.DOMAIN}/success`,
      cancel_url: `${process.env.DOMAIN}/cart`
    });

    res.redirect(session.url);
  } catch (err) {
    console.error(err);
    res.status(500).send("checkout error");
  }
});

app.get("/success", (req, res) => {
  req.session.cart = [];

  res.send(`
    <h1>order complete</h1>
    <p>thank you for shopping feb & rev.</p>
    <a href="/">back to shop</a>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`feb & rev running on port ${PORT}`);
});
