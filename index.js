const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const cors = require("cors");
const postmark = require("postmark");

const app = express();

// Allow only your frontend
app.use(cors({
  origin: 'https://siwakhelweholdings.co.za'
}));
app.use(bodyParser.json());

// Env variables
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN || "POSTMARK_API_TEST";
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
        },
      },
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    // ✅ After Paystack responds successfully, send email
    const cartList = items.map((item, i) => {
      return `${i + 1}. ${item.preset}, ${item.handleType}, ${item.mugType}, ${item.mugColor}, ${item.replacementName} — R${item.price}`;
    }).join("\n");

    const emailBody = `
Hi ${fullNameValue},

Your order has been initiated successfully. Here are the items you selected:

${cartList}

Delivery Method: ${deliveryMethod}
Total: R${amount}

This email was sent in test mode.
    `;

    await postmarkClient.sendEmail({
      From: "you@yourdomain.com", // ✅ Replace with verified Postmark sender
      To: emailValue,
      Subject: "Your Order Confirmation (Test Mode)",
      TextBody: emailBody,
    });

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
