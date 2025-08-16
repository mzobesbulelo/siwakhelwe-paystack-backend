const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const postmark = require("postmark");

const app = express();

// ✅ Proper CORS setup
app.use(cors({
  origin: 'https://siwakhelweholdings.co.za',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.options("*", cors());
app.use(bodyParser.json());

// Env variables
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
    // 1. INITIATE PAYSTACK PAYMENT
    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: emailValue,
        amount: amount * 100, // Paystack uses kobo
        metadata: {
          custom_fields: [
            { display_name: "Full Name", variable_name: "full_name", value: fullNameValue },
            { display_name: "Phone Number", variable_name: "phone_number", value: phoneValue },
            { display_name: "Delivery Method", variable_name: "delivery_method", value: deliveryMethod },
            {
              display_name: "Cart Items",
              variable_name: "cart_items",
              value: Array.isArray(items)
                ? items.map((item, i) => {
                    let details = Object.entries(item)
                      .map(([key, val]) => `${key}: ${val}`)
                      .join(", ");
                    return `Item ${i + 1}: ${details}`;
                  }).join(" | ")
                : "No items"
            }
          ]
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // 2. FORMAT ITEMS FOR POSTMARK TEMPLATE
    const formattedItems = items.map((item, i) => {
      let nameParts = [];

      // Build details dynamically from keys that exist
      if (item.preset) nameParts.push(`Preset: ${item.preset}`);
      if (item.handleType) nameParts.push(`Handle Type: ${item.handleType}`);
      if (item.mugType) nameParts.push(`Mug Type: ${item.mugType}`);
      if (item.mugColor) nameParts.push(`Mug Color: ${item.mugColor}`);
      if (item.replacementName) nameParts.push(`Replacement Name: ${item.replacementName}`);

      // If no known fields exist, fall back to all keys
      if (nameParts.length === 0) {
        nameParts = Object.entries(item).map(([key, val]) => `${key}: ${val}`);
      }

      return {
        name: nameParts.join(", "),
        quantity: item.quantity || 1,
        price: item.price || 0
      };
    });

    // 3. SEND POSTMARK TEMPLATE EMAIL
    await postmarkClient.sendEmailWithTemplate({
      From: "test@siwakhelweholdings.co.za", // ✅ Must be verified in Postmark
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
