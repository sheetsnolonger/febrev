const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");

app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const products = [
{
  id: 1,
  name: "medium black handmade stuffed crochet kitty",
  price: 20,
  image: "",
  description: "this crocheted kitty is not only a stuffed animal, but a friend. crocheted with black yarn, white button eyes, and a white X mouth.",
  ebay: "https://www.ebay.com/"
}
];

app.get("/", (req, res) => {
  res.render("index", {
    title: "feb & rev",
    products
  });
});

app.get("/product/:id", (req, res) => {
  const product = products.find(p => p.id === Number(req.params.id));

  if (!product) {
    return res.status(404).send("product not found");
  }

  res.render("product", {
    title: product.name,
    product
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`feb & rev running on port ${PORT}`);
});
