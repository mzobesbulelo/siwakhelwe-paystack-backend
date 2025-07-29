const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const app = express();
const cors = require("cors");

app.use(cors({
  origin: 'https://siwakhelewholdings.co.za'
}));
app.use(bodyParser.json());

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

app.post("/pay", async (req, res) => {
  const {
    amount,
    items,
    deliveryMethod,
    phoneValue,
    emailValue,
    fullNameValue,
  } = req.body;

  console.log("Received items:", items);

  try {
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: emailValue,
        amount: amount * 100, // amount in kobo
        metadata: {
          custom_fields: [
            {
              display_name: "Full Name",
              variable_name: "full_name",
              value: fullNameValue
            },
            {
              display_name: "Phone Number",
              variable_name: "phone_number",
              value: phoneValue
            },
            {
              display_name: "Delivery Method",
              variable_name: "delivery_method",
              value: deliveryMethod
            },
            {
              display_name: "Cart Items",
              variable_name: "cart_items",
              value: Array.isArray(items)
                ? items
                    .map(
                      (item, i) =>
                        `Item ${i + 1}: ${item.preset}, ${item.handleType}, ${item.mugType}, ${item.mugColor}, ${item.replacementName}, ${item.price}`
                    )
                    .join(" | ")
                : "No items"
            }
          ]
        }
,
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    console.log("Paystack response:", response.data);
    res.send(response.data);
  } catch (error) {
    console.error(
      "Error initializing payment:",
      error.response?.data || error.message,
    );
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Paystack backend is running");
});

app.listen(3000, () => console.log("Server running on port 3000"));
