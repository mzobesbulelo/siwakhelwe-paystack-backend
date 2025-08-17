// server.js
require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const postmark = require("postmark");

const app = express();

// --- CORS ---
app.use(cors({
  origin: "https://siwakhelweholdings.co.za",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.options("*", cors());

// --- Body parsing ---
app.use(express.json());

// --- Env ---
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN;
const postmarkClient = new postmark.ServerClient(POSTMARK_TOKEN);

// ---------- Helpers ----------
const isPlaceholder = (val) => {
  if (typeof val !== "string") return false;
  return /^item\s*\d+$/i.test(val.trim());
};

const firstStringLike = (obj, keys) => {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
      const v = obj[k];
      if (v == null) continue;
      if (typeof v === "string" && v.trim()) return v.trim();
      if (typeof v === "number") return String(v);
    }
  }
  return null;
};

const findAddonPrice = (obj) => {
  if (!obj || typeof obj !== "object") return null;
  const candidates = ["addon", "addOn", "extra", "price", "amount", "value"];
  for (const k of candidates) {
    const v = obj[k];
    const num = Number(v);
    if (Number.isFinite(num) && num !== 0) return num;
  }
  return null;
};

const asReadable = (value) => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(asReadable).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const nameish = firstStringLike(value, ["name", "label", "title", "value", "text"]);
    const addon = findAddonPrice(value);
    if (nameish) return addon ? `${nameish} +R${addon}` : nameish;
    return Object.entries(value)
      .map(([k, v]) => `${toTitle(k)}: ${asReadable(v)}`)
      .join(", ");
  }
  return String(value);
};

const toTitle = (k) =>
  k.replace(/[_-]+/g, " ")
   .replace(/\b\w/g, (c) => c.toUpperCase());

const describeItem = (item, index) => {
  if (item == null) return `Item ${index}`;
  if (typeof item === "string") return item.trim() || `Item ${index}`;

  const parts = [];
  const knownFields = [
    ["preset", "Preset"],
    ["handleType", "Handle Type"],
    ["mugType", "Mug Type"],
    ["mugColor", "Mug Color"],
    ["replacementName", "Replacement Name"],
    ["variant", "Variant"],
    ["size", "Size"],
    ["color", "Color"],
    ["engraving", "Engraving"],
    ["notes", "Notes"],
  ];

  for (const [key, label] of knownFields) {
    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
    let raw = item[key];
    if (key === "preset" && typeof raw === "string" && isPlaceholder(raw)) continue;
    const val = asReadable(raw);
    if (val) parts.push(`${label}: ${val}`);
  }

  if (parts.length === 0 && typeof item === "object") {
    const skip = new Set(["quantity", "qty", "price", "total", "lineTotal", "id", "sku", "image", "images", "thumb", "_line", "preset"]);
    const rest = Object.entries(item)
      .filter(([k, v]) => !skip.has(k) && v != null && String(v).trim() !== "")
      .map(([k, v]) => `${toTitle(k)}: ${asReadable(v)}`);
    if (rest.length) parts.push(...rest);
  }

  return parts.length === 0 ? `Item ${index}` : parts.join(", ");
};

// ---------- Routes ----------

// Initialize Paystack transaction
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
    const totalAmount = Number.isFinite(Number(amount)) && Number(amount) > 0
      ? Number(amount)
      : computedTotal;

    const cartItemsForMetadata = normalized
      .map((it, i) => `Item ${i + 1}: ${describeItem(it, i + 1)}`)
      .join(" | ");

    const initPayload = {
      email: emailValue,
      amount: Math.round(totalAmount * 100),
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

// Verify Paystack transaction and send receipt
app.post("/paystack/verify", async (req, res) => {
  try {
    const { reference, emailValue, fullNameValue, phoneValue, deliveryMethod, items } = req.body;

    if (!reference) return res.status(400).json({ error: "Missing transaction reference." });

    const verifyRes = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });

    const data = verifyRes.data.data;

    if (data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful" });
    }

    const formattedItems = items.map((it, i) => ({
      name: describeItem(it, i + 1),
      quantity: it.quantity,
      price: it.price
    }));

    await postmarkClient.sendEmailWithTemplate({
      From: "test@siwakhelweholdings.co.za",
      To: emailValue,
      TemplateAlias: "mugs_receipt",
      TemplateModel: {
        fullNameValue,
        emailValue,
        phoneValue,
        deliveryMethod: deliveryMethod || "",
        amount: data.amount / 100,
        items: formattedItems
      }
    });

    return res.json({ success: true, data });
  } catch (err) {
    console.error("Error verifying payment:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});

app.get("/", (_req, res) => res.send("Paystack backend is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
