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
// const TEMPERATURE_THRESHOLD = 30;
// const HUMIDITY_THRESHOLD = 70;
// const client = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY, // put in .env
// });

const TERMII_API_KEY =
  "TLdsBNLBkWlhPmYJrIrowxKKYrbiMtkdGjTVkaaiPZpCjNeLuEpiYjzwTzgvmf";
const TERMII_BASE_URL = "https://v3.api.termii.com";

// Store connected clients
const clients = new Set();

let grainSettings = null;

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
  grainType: { type: String, default: "Maize" },
});

const settingsSchema = new mongoose.Schema({
  sendEmail: Boolean,
  sendSMS: Boolean,
  email: String,
  phone: String,
  grainType: String,
  maxTemp: String,
  maxHumid: String,
  turnOnFan: Boolean,
  activateSetUp: Boolean,
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
    let settings = await Settings.findById(settings_ID).lean();
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
    let settings = await Settings.findById(settings_ID).lean();
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

function calculateEMC(Rh, T, grainType) {
  const constants = {
    Paddy: [0.0000122, 1.35],
    Maize: [0.0000198, 1.9],
    Wheat: [0.00000106, 3.03],
    Sorghum: [0.0000061, 2.31],
  };
  const [C, N] = constants[grainType];
  const numerator = -1 * Math.log(1 - Rh / 100);
  const denominator = C * T;
  const emc = Math.pow(numerator / denominator, 1 / N);
  return emc;
}

const settings_ID = "68f294ce4a2cdfe419f9dd85";

app.get("/", async (req, res) => {
  try {
    let settings;
    if (!grainSettings) {
      grainSettings = await Settings.findById(settings_ID).lean();
    }
    settings = grainSettings;
    const readingsLength = await Readings.find().lean();
    // // console.log({readingsLength})
    // let settings = await Settings.create({
    //   sendEmail: false,
    //   sendSMS: false,
    //   email: "segunsunday619@gmail.com",
    //   phone: "07037887923",
    //   grainType: "Maize",
    //   maxTemp: "30",
    //   maxHumid: "70",
    //   turnOnFan: false,
    //   activateSetUp: true,
    // });
    // let readingsLength = [1];

    // return res.status(200).send({
    //   msg: "AI-Powered Grain Storage Monitoring System is online",
    //   data: { settings, readingsLength: readingsLength.length },
    // });
    return res.status(200).send("AI-Powered Grain Storage Monitoring System is Online");
  } catch (error) {
    console.error(error);
  }
});

app.post("/fetch-graph-data", async (req, res) => {
  try {
    console.log("Fetching Graph Data");

    let settings;
    if (!grainSettings) {
      grainSettings = await Settings.findById(settings_ID).lean();
    }
    settings = grainSettings;

    let { from, to } = req.body; // received date range from the website dashboard
    //  console.log({from, to})
    const readings = await Readings.find({
      timeStamp: {
        $gte: from,
        $lte: to,
      },
      grainType: settings.grainType,
    }).lean(); // query and filter database records based on the date range

    let timeZone = []; // store the arranged records timeStamps
    let temps = []; // store the arranged records temperature data
    let humids = []; // store the arranged records humidity data
    let EMC = [];
    let DI = [];

    for (let reading of readings) {
      const timeStamp = new Date(reading.timeStamp);
      const _emc = calculateEMC(
        reading.humidity,
        reading.temperature,
        settings.grainType
      );
      const Pas =
        610.78 *
        Math.exp((17.27 * reading.temperature) / (reading.temperature + 273));
      const _di = (reading.humidity - 65) * Pas * 1e-4;
      let hours = timeStamp.getHours();
      let minutes = timeStamp.getMinutes();
      let seconds = timeStamp.getSeconds();
      timeZone.push(`${hours}h:${minutes}m:${seconds}s`);
      temps.push(reading.temperature);
      humids.push(reading.humidity);
      EMC.push(_emc);
      DI.push(_di);
    }

    // send the timezone, humidity, temperature data to the website dashboard
    return res.status(200).send({ timeZone, humids, temps, EMC, DI });
  } catch (error) {
    console.error(error);
  }
});

app.post("/update-notifications-settings", async (req, res) => {
  let { sendEmail, sendSMS } = req.body;
  try {
    let updatedSettings = await Settings.findByIdAndUpdate(
      settings_ID,
      { sendEmail, sendSMS },
      { new: true }
    ).lean();
    if (
      updatedSettings.sendEmail === sendEmail &&
      updatedSettings.sendSMS === sendSMS
    ) {
      grainSettings = null
      return res
        .status(200)
        .send({ msg: "Settings Updated Successfully", data: updatedSettings });
    }
  } catch (error) {
    console.error(error);
  }
});

app.post("/update-user-info", async (req, res) => {
  let payload = { ...req.body }; //represents a single key-pair object
  try {
    let updatedSettings = await Settings.findByIdAndUpdate(
      settings_ID,
      payload,
      { new: true }
    ).lean();
    let extractedPayloadKey = Object.keys(payload)[0];
    if (updatedSettings[extractedPayloadKey] === payload[extractedPayloadKey]) {
      grainSettings = null;
      return res
        .status(200)
        .send({ msg: "Settings Updated Successfully", data: updatedSettings });
    } else {
      return res
        .status(500)
        .send({ msg: "Failed to Update", data: updatedSettings });
    }
  } catch (error) {
    console.error(error);
  }
});

app.get("/get-settings", async (req, res) => {
  try {
    let settings;
    if (!grainSettings) {
      grainSettings = await Settings.findById(settings_ID).lean();
    }
    settings = grainSettings;

    return res
      .status(200)
      .send({ msg: "Settings Retrieved Successfully", data: settings });
  } catch (error) {
    console.error(error);
  }
});

app.get("/thresholds", async (req, res) => {
  try {
    let settings;
    if (!grainSettings) {
      grainSettings = await Settings.findById(settings_ID).lean();
    }
    settings = grainSettings;

    return res.status(200).send({
      maxTemp: Number(settings.maxTemp),
      maxHumid: Number(settings.maxHumid),
    });
  } catch (error) {
    console.error(error);
  }
});

app.post("/", async (req, res) => {
  console.log("ESP8266 Sent Some Data");
  try {
    let settings;
    if (!grainSettings) {
      grainSettings = await Settings.findById(settings_ID).lean();
    }
    settings = grainSettings;

    const { temperature, humidity } = req.body;
    const {
      sendEmail: _sendMail,
      sendSMS: _sendSMS,
      maxTemp,
      maxHumid,
    } = settings;
    // console.log(maxTemp, maxHumid)
    let date = Date.now(); // get current date (timeStamp)
    const reading = {
      timeStamp: date,
      temperature: temperature,
      humidity: humidity,
    }; // modify data received from the ESP8266 by adding a date (timeStamp)
    console.log(reading);

    let response = await Readings.create(reading); // save modified data to database

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

    try {
      let turnOnFan = false;
      if (temperature >= Number(maxTemp) || humidity >= Number(maxHumid)) {
        turnOnFan = true;
      } else if (temperature < Number(maxTemp) && humidity < Number(maxHumid)) {
        turnOnFan = false;
      }
      let updatedSettings = await Settings.findByIdAndUpdate(
        settings_ID,
        { turnOnFan },
        { new: true }
      ).lean();
      grainSettings = null
    } catch (error) {
      console.error(error);
    }

    if (temperature >= maxTemp && humidity >= maxHumid) {
      _sendMail &&
        sendMail(
          `Critical temperature at ${temperature}°C. Please check on the grains.\nCritical humidity at ${humidity}%. Please check on the grains`
        ); // send high temperature and humidity alert mail
      _sendSMS &&
        sendSMS(
          `Critical temperature at ${temperature}°C. Please check on the grains.\nCritical humidity at ${humidity}%. Please check on the grains`
        ); // send high temperature and humidity alert SMS
    } else if (temperature >= maxTemp) {
      _sendMail &&
        sendMail(
          `Critical temperature at ${temperature}°C. Please check on the grains`
        ); // send high temperature alert mail
      _sendSMS &&
        sendSMS(
          `Critical temperature at ${temperature}°C. Please check on the grains`
        ); // send high temperature alert SMS
    } else if (humidity >= maxHumid) {
      _sendMail &&
        sendMail(
          `Critical humidity at ${humidity}%. Please check on the grains`
        ); // send high humidity alert mail
      _sendSMS &&
        sendSMS(
          `Critical humidity at ${humidity}%. Please check on the grains`
        ); // send high humidity alert SMS
    } else {
      dontSendMail();
    }

    return res.status(200).send({ data: response }); // end the operation as successful
  } catch (error) {
    console.error(error);
  }
});

server.listen(PORT, "0.0.0.0", (error) => {
  if (!error) {
    console.log("✅ App is listening on port " + PORT);
  } else {
    console.error("🌋 Error occurred, server can't start", error);
  }
});
