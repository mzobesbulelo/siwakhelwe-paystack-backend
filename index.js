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
    const response
