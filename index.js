import "dotenv/config";
import express from "express";
import cors from "cors";
import http from "http";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import OpenAI from "openai";
import twilio from "twilio";
import axios from "axios";
import WebSocket, { WebSocketServer } from "ws";
import nodemailer from "nodemailer";
// import { SettingsContextImpl } from "twilio/lib/rest/voice/v1/dialingPermissions/settings";
mongoose.set("strictQuery", false);

const app = express();
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const TEMPERATURE_THRESHOLD = 30;
const HUMIDITY_THRESHOLD = 70;
// const client = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY, // put in .env
// });

const TERMII_API_KEY =
  "TLdsBNLBkWlhPmYJrIrowxKKYrbiMtkdGjTVkaaiPZpCjNeLuEpiYjzwTzgvmf";
const TERMII_BASE_URL = "https://v3.api.termii.com";

// Store connected clients
const clients = new Set();

wss.on("connection", (ws) => {
  console.log("Frontend connected");
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

const readingsSchema = new mongoose.Schema({
  timeStamp: { type: Number, required: true },
  temperature: { type: Number, required: true },
  humidity: { type: Number, required: true },
});

const settingsSchema = new mongoose.Schema({
  sendEmail: Boolean,
  sendSMS: Boolean,
  email: String,
  phone: String,
});

const Readings = mongoose.model("Readings", readingsSchema);
const Settings = mongoose.model("Settings", settingsSchema);

const MONGODB_URI = process.env.MONGODB_URI;

let isConnected = false; // Track the connection state
let backoff = 1; // Track the connection retry delay
let timeoutId; //Stores the id for the setInterval

export default async function connectMongoDB() {
  if (isConnected) {
    console.log("➡️ Using existing database connection");
    return;
  }

  try {
    const db = await mongoose.connect(MONGODB_URI, {
      maxPoolSize: 10,
    });

    isConnected = db.connections[0].readyState === 1;
    if (isConnected && timeoutId) clearTimeout(timeoutId);

    console.log("✅ MongoDB Connected");
  } catch (error) {
    console.error("❌ MongoDB Connection Error:", error.message || error);

    backoff = Math.min(backoff * 2, 60); // Exponential backoff, capped at 60s
    console.log(`⏳ Retrying in ${backoff} seconds...`);

    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(connectMongoDB, backoff * 1000);
  }
}
await connectMongoDB();

async function sendSMS(text) {
  try {
    let settings = await Settings.findById("68bc0fbe497970b72f1f6598").lean();
    let { phone } = settings;
    phone = `234${phone.slice(1)}`;
    const res = await fetch(`${TERMII_BASE_URL}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: phone,
        from: "IoTGSMS",
        sms: text,
        type: "plain",
        channel: "generic",
        api_key: TERMII_API_KEY,
      }),
    });
    if (!res.ok) {
      return { success: false, message: res.text };
    }
    console.log("SMS Sent Successfully");
    return res.json();
  } catch (error) {
    console.error("SMS Failed to Send");
    console.error(error);
    return { success: false, message: "SMS failed to send" };
  }
}

async function sendMail(text) {
  try {
    let settings = await Settings.findById("68bc0fbe497970b72f1f6598").lean();
    let { email } = settings;

    let transporter = nodemailer.createTransport({
      service: "gmail", // Or use SMTP settings
      auth: {
        user: "elijahdimeji549@gmail.com",
        pass: "bzmj myct dizy ydsd", // Use app password if using Gmail
      },
    });
    await transporter.sendMail({
      from: '"Grain Storage Monitoring System" <your_email@gmail.com>',
      to: email,
      subject: "Grain Storage Alert",
      text,
    });
    console.log("Email Sent Successfully");
    return { success: true, message: "Email sent successfully" };
  } catch (error) {
    console.error(error);
    console.error("Email Failed to Send");
    return { success: false, message: "Email failed to send" };
  }
}

function dontSendMail() {
  console.log("Storage Conditions are good and optimal");
}

app.get("/", async (req, res) => {
  try {
    let settings = await Settings.findById("68bc0fbe497970b72f1f6598");

    return res.status(200).send({
      msg: "AI-Powered Grain Storage Monitoring System",
      data: settings,
    });
  } catch (error) {
    console.error(error);
  }
});

app.post("/fetch-graph-data", async (req, res) => {
  try {
    console.log("Fetching Graph Data");
    let { from, to } = req.body; // received date range from the website dashboard
    const readings = await Readings.find({
      timeStamp: {
        $gte: from,
        $lte: to,
      },
    }).lean(); // query and filter database records based on the date range

    let timeZone = []; // store the arranged records timeStamps
    let temps = []; // store the arranged records temperature data
    let humids = []; // store the arranged records humidity data

    for (let reading of readings) {
      const timeStamp = new Date(reading.timeStamp); // con
      let hours = timeStamp.getHours();
      let minutes = timeStamp.getMinutes();
      let seconds = timeStamp.getSeconds();
      timeZone.push(`${hours}h:${minutes}m:${seconds}s`);
      temps.push(reading.temperature);
      humids.push(reading.humidity);
    }

    // send the timezone, humidity, temperature data to the website dashboard
    return res.status(200).send({ timeZone, humids, temps });
  } catch (error) {
    console.error(error);
  }
});

app.post("/update-notifications-settings", async (req, res) => {
  console.log(req.body);
  let { sendEmail, sendSMS } = req.body;
  try {
    let updatedSettings = await Settings.findByIdAndUpdate(
      "68bc0fbe497970b72f1f6598",
      { sendEmail, sendSMS },
      { new: true }
    ).lean();
    if (
      updatedSettings.sendEmail === sendEmail &&
      updatedSettings.sendSMS === sendSMS
    ) {
      return res
        .status(200)
        .send({ msg: "Settings Updated Successfully", data: updatedSettings });
    }
  } catch (error) {
    console.error(error);
  }
});

app.post("/update-user-info", async (req, res) => {
  console.log(req.body);
  let { email, phone } = req.body;
  try {
    let updatedSettings = await Settings.findByIdAndUpdate(
      "68bc0fbe497970b72f1f6598",
      { email, phone },
      { new: true }
    ).lean();
    if (updatedSettings.email === email && updatedSettings.phone === phone) {
      return res
        .status(200)
        .send({ msg: "Settings Updated Successfully", data: updatedSettings });
    }
  } catch (error) {
    console.error(error);
  }
});

app.get("/get-settings", async (req, res) => {
  try {
    let settings = await Settings.findById("68bc0fbe497970b72f1f6598").lean();

    return res
      .status(200)
      .send({ msg: "Settings Retrieved Successfully", data: settings });
  } catch (error) {
    console.error(error);
  }
});

app.post("/", async (req, res) => {
  try {
    let settings = await Settings.findById("68bc0fbe497970b72f1f6598").lean();
    const { temperature, humidity } = req.body;
    const { sendEmail: _sendMail, sendSMS: _sendSMS, email, phone } = settings;
    let date = Date.now(); // get current date (timeStamp)
    const reading = {
      timeStamp: date,
      temperature: temperature,
      humidity: humidity,
    }; // modify data received from the ESP8266 by adding a date (timeStamp)
    console.log(reading);

    let response = await Readings.create(reading).lean(); // save modified data to database

    for (let client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            event: "sensorUpdate",
            data: reading,
          })
        ); // send modified data to the website dashboard (client)
      }
    }

    if (temperature > TEMPERATURE_THRESHOLD && humidity > HUMIDITY_THRESHOLD) {
      _sendMail &&
        sendMail(
          `High temperature at ${temperature}°C. Please check on the grains`
        ); // send high temperature alert mail
      _sendSMS &&
        sendSMS(
          `High temperature at ${temperature}°C. Please check on the grains`
        ); // send high temperature alert SMS
      _sendMail &&
        sendMail(`High humidity at ${humidity}%. Please check on the grains`); // send high humidity alert mail
      _sendSMS &&
        sendSMS(`High humidity at ${humidity}%. Please check on the grains`); // send high humidity alert SMS
    } else if (temperature > TEMPERATURE_THRESHOLD) {
      _sendMail &&
        sendMail(
          `High temperature at ${temperature}°C. Please check on the grains`
        ); // send high temperature alert mail
      _sendSMS &&
        sendSMS(
          `High temperature at ${temperature}°C. Please check on the grains`
        ); // send high temperature alert SMS
    } else if (humidity > HUMIDITY_THRESHOLD) {
      _sendMail &&
        sendMail(`High humidity at ${humidity}%. Please check on the grains`); // send high humidity alert mail
      _sendSMS &&
        sendSMS(`High humidity at ${humidity}%. Please check on the grains`); // send high humidity alert SMS
    } else {
      dontSendMail();
    }

    return res.status(200).send({ data: response }); // end the operation as successful
  } catch (error) {
    console.error(error);
  }
});

server.listen(PORT, (error) => {
  if (!error) {
    console.log("✅ App is listening on port " + PORT);
  } else {
    console.error("🌋 Error occurred, server can't start", error);
  }
});
