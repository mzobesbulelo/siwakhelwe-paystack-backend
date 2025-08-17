require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const postmark = require("postmark");
const crypto = require("crypto");

const app = express();

// --- CORS ---
app.use(cors({
  origin: "https://siwakhelweholdings.co.za",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

// --- Body parsing ---
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// --- Env ---
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN;
const postmarkClient = new postmark.ServerClient(POSTMARK_TOKEN);

// ---------- Helpers ----------
const asReadable = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(asReadable).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const nameish = value.name || value.label || value.title || value.value || value.text;
    const addon = value.price || value.amount || value.value;
    if (nameish) return addon ? `${nameish} +R${addon}` : nameish;
    return Object.entries(value)
      .map(([k, v]) => `${k}: ${asReadable(v)}`)
      .join(", ");
  }
  return String(value);
};

const describeItem = (item, index) => {
  if (!item) return `Item ${index}`;
  if (typeof item === "string") return item.trim() || `Item ${index}`;
  const parts = [];
  const knownFields = [
    ["preset", "Preset"],
    ["handleType", "Handle Type"],
    ["mugType", "Mug Type"],
    ["mugColor", "Mug Color"],
    ["replacementName", "Replacement Name"]
  ];
  for (const [key, label] of knownFields) {
    if (item[key]) parts.push(`${label}: ${asReadable(item[key])}`);
  }
  if (parts.length === 0) return `Item ${index}`;
  return parts.join(", ");
};

// ---------- Routes ----------

// Initialize payment (frontend calls this)
app.post("/pay", async (req, res) => {
  try {
    const { amount, items, deliveryMethod, phoneValue, emailValue, fullNameValue } = req.body;

    if (!emailValue || !phoneValue || !fullNameValue) {
      return res.status(400).json({ error: "Missing customer details." });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Cart is empty or invalid." });
    }

    const normalized = items.map((it, idx) => {
      const quantity = Number(it?.quantity) > 0 ? Number(it.quantity) : 1;
      const price = Number.isFinite(Number(it?.price)) ? Number(it.price) : 0;
      return { ...it, quantity, price, _line: idx + 1 };
    });

    const computedTotal = normalized.reduce((s, it) => s + it.price * it.quantity, 0);
    const totalAmount = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : computedTotal;

    const cartItemsForMetadata = normalized
      .map((it, i) => `Item ${i + 1}: ${describeItem(it, i + 1)}`)
      .join(" | ");

    const initPayload = {
      email: emailValue,
      amount: Math.round(totalAmount * 100), // Kobo
      metadata: {
        custom_fields: [
          { display_name: "Full Name", variable_name: "full_name", value: fullNameValue },
          { display_name: "Phone Number", variable_name: "phone_number", value: phoneValue },
          { display_name: "Delivery Method", variable_name: "delivery_method", value: deliveryMethod || "" },
          { display_name: "Cart Items", variable_name: "cart_items", value: cartItemsForMetadata || "No items" },
        ],
      },
    };

    const paystackRes = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      initPayload,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" } }
    );

    return res.send(paystackRes.data);
  } catch (err) {
    console.error("Error initializing payment:", err?.response?.data || err.message);
    return res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// Paystack webhook (send email only on successful charge)
app.post("/paystack-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-paystack-signature"];
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY)
                       .update(req.rawBody)
                       .digest("hex");

    if (hash !== signature) {
      console.error("Webhook signature mismatch");
      return res.sendStatus(400);
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const emailValue = event.data.customer?.email;
      const fullNameValue = event.data.metadata?.custom_fields?.find(f => f.variable_name === "full_name")?.value;
      const phoneValue = event.data.metadata?.custom_fields?.find(f => f.variable_name === "phone_number")?.value;
      const deliveryMethod = event.data.metadata?.custom_fields?.find(f => f.variable_name === "delivery_method")?.value;
      const cartItemsString = event.data.metadata?.custom_fields?.find(f => f.variable_name === "cart_items")?.value;

      if (!emailValue) {
        console.error("Webhook: customer email missing");
        return res.sendStatus(400);
      }

      // Convert cart items string into an array of objects for Postmark
      const itemsArray = (cartItemsString || "")
        .split(" | ")
        .map(line => {
          const match = line.match(/Item \d+: (.+) \+R(\d+)/);
          return {
            name: match ? match[1] : line,
            quantity: 1, // default quantity
            price: match ? Number(match[2]) : 0
          };
        });

      // Send the email
      await postmarkClient.sendEmailWithTemplate({
        From: "sales@siwakhelweholdings.co.za",
        To: emailValue,
        TemplateAlias: "mugs_receipt",
        TemplateModel: {
          fullNameValue,
          emailValue,
          phoneValue,
          deliveryMethod,
          amount: event.data.amount / 100, // convert from Kobo
          items: itemsArray
        }
      });

      console.log("Receipt email sent to", emailValue);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Error sending email:", err);
    res.sendStatus(500);
  }
});

app.get("/", (_req, res) => res.send("Paystack backend is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
