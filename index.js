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

// --- Body parsing (keep rawBody for Paystack signature verification) ---
app.use(express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  }
}));

// --- Env ---
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const POSTMARK_TOKEN = process.env.POSTMARK_TOKEN;
const postmarkClient = new postmark.ServerClient(POSTMARK_TOKEN);

// ---------- Helpers ----------
const stripTags = (s = "") => String(s).replace(/<[^>]+>/g, "").trim();

const stripLabel = (s = "", label = "") => {
  const clean = stripTags(s);
  if (!label) return clean;
  // Remove leading "Label:" (case-insensitive, with/without extra spaces)
  const re = new RegExp("^" + label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*", "i");
  return clean.replace(re, "").trim();
};

const numFromPrice = (s) => {
  if (typeof s === "number") return s;
  const m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
};

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
  const parts = [];
  const preset = stripLabel(item.preset, "Preset");
  const handleType = stripLabel(item.handleType, "Handle Type");
  const mugType = stripLabel(item.mugType, "Mug Type");
  const mugColor = stripLabel(item.mugColor, "Mug Color");
  const replacementName = stripLabel(item.replacementName, "Replacement Name");

  if (preset) parts.push(`Preset: ${preset}`);
  if (handleType) parts.push(`Handle Type: ${handleType}`);
  if (mugType) parts.push(`Mug Type: ${mugType}`);
  if (mugColor) parts.push(`Mug Color: ${mugColor}`);
  if (replacementName) parts.push(`Replacement Name: ${replacementName}`);

  return parts.length ? parts.join(", ") : `Item ${index}`;
};

const normalizeCart = (items) => {
  if (!Array.isArray(items)) return [];
  return items.map((it, idx) => {
    const quantity = Number(it?.quantity) > 0 ? Number(it.quantity) : 1;

    // price can arrive as "R90" or "Price: R90" or "<b>Price:</b> R90"
    const price = numFromPrice(it?.price);

    const item = {
      preset: stripLabel(it?.preset, "Preset"),
      handleType: stripLabel(it?.handleType, "Handle Type"),
      mugType: stripLabel(it?.mugType, "Mug Type"),
      mugColor: stripLabel(it?.mugColor, "Mug Color"),
      replacementName: stripLabel(it?.replacementName, "Replacement Name"),
      quantity,
      price,
      _line: idx + 1,
    };

    return { ...it, ...item, _name: describeItem(item, idx + 1) };
  });
};

const toTemplateItems = (cart) => {
  return cart.map(it => ({
    name: it._name || describeItem(it, it._line || 1),
    quantity: it.quantity || 1,
    price: Number.isFinite(Number(it.price)) ? Number(it.price) : 0
  }));
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

    // Normalize + clean the cart and store it structurally in metadata
    const normalized = normalizeCart(items);
    const computedTotal = normalized.reduce((s, it) => s + (it.price * (it.quantity || 1)), 0);
    const totalAmount = Number.isFinite(Number(amount)) && Number(amount) > 0 ? Number(amount) : computedTotal;

    const cartItemsForMetadata = normalized
      .map((it, i) => `Item ${i + 1}: ${it._name} (x${it.quantity}) @ R${it.price}`)
      .join(" | ");

    const initPayload = {
      email: emailValue,
      amount: Math.round(totalAmount * 100), // Kobo
      metadata: {
        cart: normalized,                    // <— structured cart for the webhook
        delivery_method: deliveryMethod || "",
        customer: {
          full_name: fullNameValue,
          phone: phoneValue,
          email: emailValue
        },
        // Pretty view in Paystack dashboard
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
                       .update(req.rawBody || "")
                       .digest("hex");

    if (!signature || hash !== signature) {
      console.error("Webhook signature mismatch");
      return res.sendStatus(400);
    }

    const event = req.body;

    if (event?.event !== "charge.success") {
      return res.sendStatus(200);
    }

    // Ack first; continue processing
    res.sendStatus(200);

    const data = event.data || {};
    const emailValue = data.customer?.email;
    if (!emailValue) {
      console.error("Webhook: customer email missing; cannot send receipt.");
      return;
    }

    const meta = data.metadata || {};

    // Preferred: structured cart
    let itemsArray;
    if (Array.isArray(meta.cart) && meta.cart.length) {
      itemsArray = toTemplateItems(normalizeCart(meta.cart));
    } else {
      // Fallback: parse pretty string (older flows)
      const cartItemsString = (Array.isArray(meta.custom_fields) ? meta.custom_fields : [])
        .find(f => f.variable_name === "cart_items")?.value || "";

      itemsArray = cartItemsString.split(" | ").filter(Boolean).map((line, idx) => {
        const qtyMatch = line.match(/\(x(\d+)\)/i);
        const priceMatch = line.match(/@ R([0-9]+(?:\.[0-9]+)?)/i);
        return {
          name: line.replace(/\(x\d+\)\s*@ R[0-9.]+/i, "").trim(),
          quantity: qtyMatch ? Number(qtyMatch[1]) : 1,
          price: priceMatch ? Number(priceMatch[1]) : 0
        };
      });
    }

    const fullNameValue =
      meta.customer?.full_name ||
      (Array.isArray(meta.custom_fields) ? meta.custom_fields : []).find(f => f.variable_name === "full_name")?.value ||
      "";

    const phoneValue =
      meta.customer?.phone ||
      (Array.isArray(meta.custom_fields) ? meta.custom_fields : []).find(f => f.variable_name === "phone_number")?.value ||
      "";

    const deliveryMethod =
      meta.delivery_method ||
      (Array.isArray(meta.custom_fields) ? meta.custom_fields : []).find(f => f.variable_name === "delivery_method")?.value ||
      "";

    const amountRand = Number(((data.amount || 0) / 100).toFixed(2));

    // 1) Customer email
    await postmarkClient.sendEmailWithTemplate({
      From: "sales@siwakhelweholdings.co.za",
      To: emailValue,
      TemplateAlias: "mugs_receipt",
      TemplateModel: {
        fullNameValue,
        emailValue,
        phoneValue,
        deliveryMethod,
        amount: amountRand,
        items: itemsArray
      }
    });

    // 2) Internal copy to Sales
    await postmarkClient.sendEmailWithTemplate({
      From: "sales@siwakhelweholdings.co.za",
      To: "sales@siwakhelweholdings.co.za",
      TemplateAlias: "mugs_receipt",
      TemplateModel: {
        fullNameValue,
        emailValue,
        phoneValue,
        deliveryMethod,
        amount: amountRand,
        items: itemsArray
      }
    });

    console.log("Receipt emails sent to", emailValue, "and sales@siwakhelweholdings.co.za");

  } catch (err) {
    console.error("Error handling webhook:", err);
    try { res.sendStatus(200); } catch (_e) {}
  }
});

app.get("/", (_req, res) => res.send("Paystack backend is running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
