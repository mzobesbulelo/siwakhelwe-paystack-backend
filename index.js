const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const postmark = require("postmark");

const app = express();

// ✅ CORS - this must come *before* any other middleware or routes
app.use(cors({
  origin: "https://siwakhelweholdings.co.za",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
}));

// ✅ Preflight request handler (needed for some browsers and servers)
app.options("*", cors());

app.use(bodyParser.json());

// ✅ Environment variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN;
const postmarkClient = new postmark.ServerClient(POSTMARK_TOKEN);

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
    // 🟢 Initialize Paystack payment
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: emailValue,
        amount: amount * 100,
        metadata: {
          custom_fields: [
            { display_name: "Full Name", variable_name: "full_name", value: fullNameValue },
            { display_name: "Phone Number", variable_name: "phone_number", value: phoneValue },
            { display_name: "Delivery Method", variable_name: "delivery_method", value: deliveryMethod },
            {
              display_name: "Cart Items",
              variable_name: "cart_items",
              value: Array.isArray(items)
                ? items.map((item, i) =>
                    `Item ${i + 1}: ${item.preset || ""}, ${item.handleType || ""}, ${item.mugType || ""}, ${item.mugColor || ""}, ${item.replacementName || ""}, R${item.price}`
                  ).join(" | ")
                : "No items"
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    // 🟢 Format items for Postmark
    const formattedItems = items.map((item) => ({
      name: [
        item.preset,
        item.handleType,
        item.mugType,
        item.mugColor,
        item.replacementName
      ].filter(Boolean).join(", "),
      quantity: 1,
      price: item.price
    }));

    // 🟢 Send email receipt using Postmark template
    await postmarkClient.sendEmailWithTemplate({
      From: "test@siwakhelweholdings.co.za",
      To: emailValue,
      TemplateAlias: "mugs_receipt",
      TemplateModel: {
        fullNameValue,
        emailValue,
        phoneValue,
        deliveryMethod,
        amount,
        items: formattedItems
      }
    });

    console.log("Paystack response:", response.data);
    res.send(response.data);

  } catch (error) {
    console.error("Error initializing payment:", error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data || error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Paystack backend is running");
});

app.listen(3000, () => console.log("Server running on port 3000"));
