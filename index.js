// index.js
import express from "express";
//import dotenv from "dotenv";
import Airtable from "airtable";
import { Blob } from "buffer";

console.log("DEBUG ENV:");
console.log("AIRTABLE_API_KEY:", process.env.AIRTABLE_API_KEY);
console.log("AIRTABLE_BASE_ID:", process.env.AIRTABLE_BASE_ID);
console.log("AIRTABLE_TABLE_NAME:", process.env.AIRTABLE_TABLE_NAME);

//dotenv.config();
const app = express();
app.use(express.json()); // Telegram sendet JSON

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Airtable init
const airtableBase = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(
  process.env.AIRTABLE_BASE_ID
);
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE_NAME || "Content Ideas";

// Helper: send message to Telegram
async function sendTelegramMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

// Helper: call OpenAI Chat Completion
async function callOpenAIChat(promptText) {
  const body = {
    model: "gpt-4o-mini", // oder gpt-4.1-mini wenn verfügbar
    messages: [
      {
        role: "system",
        content: `Du bist ein Assistent, der Content-Ideen strukturiert. Gib immer JSON zurück im Format:
{
  "title": "",
  "summary": "",
  "tags": [],
  "raw_idea": ""
}`
      },
      { role: "user", content: promptText }
    ],
    temperature: 0.2
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("OpenAI Chat error: " + txt);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content;
}

// Helper: whisper transcription (OpenAI /audio/transcriptions)
async function transcribeAudioFromBuffer(arrayBuffer, filename = "voice.oga") {
  const form = new FormData();

  // ArrayBuffer → Node Buffer
  const buffer = Buffer.from(arrayBuffer);

  // Buffer → Blob (funktioniert in Node >= 18)
  const blob = new Blob([buffer], { type: "audio/ogg" });

  // Datei an FormData anhängen
  form.append("file", blob, filename);
  form.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      // KEIN Content-Type setzen → FormData macht das automatisch!
    },
    body: form
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Whisper error: " + txt);
  }

  const data = await res.json();
  return data.text;
}

// Process idea text: call GPT, parse JSON, save to Airtable, reply to user
async function processIdeaText(text, chatId, userId) {
  try {
    const aiOutput = await callOpenAIChat(text);

    // try to find JSON in the output (robust)
    const firstBrace = aiOutput.indexOf("{");
    const lastBrace = aiOutput.lastIndexOf("}");
    const jsonText = firstBrace !== -1 && lastBrace !== -1 ? aiOutput.slice(firstBrace, lastBrace + 1) : aiOutput;

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (err) {
      // fallback: create a simple record
      parsed = {
        title: text.slice(0, 50),
        summary: text,
        tags: [],
        raw_idea: text
      };
    }

    // Save to Airtable
    await airtableBase(AIRTABLE_TABLE).create([
      {
        fields: {
            Title: parsed.title || "",
            Summary: parsed.summary || "",
            Tags: Array.isArray(parsed.tags) ? parsed.tags.join(", ") : (parsed.tags || ""),
            RawIdea: parsed.raw_idea || text,
            Source: "telegram",
            UserId: userId?.toString?.() || ""
        }
      }
    ]);

    // Reply to user
    const replyText = `Danke — ich habe deine Idee gespeichert.\n\nTitel: ${parsed.title || "—"}\n\n${parsed.summary || ""}`;
    await sendTelegramMessage(chatId, replyText);
  } catch (e) {
    console.error("processIdeaText error:", e);
    await sendTelegramMessage(chatId, "Fehler beim Verarbeiten deiner Idee. Versuche es später nochmal.");
  }
}

// Telegram webhook endpoint
app.post("/telegram", async (req, res) => {
  try {
    const update = req.body;
    // Telegram might put message in update.message or update.edited_message etc.
    const message = update.message || update.edited_message || update.channel_post;
    if (!message) return res.sendStatus(200);

    const chatId = message.chat.id;
    const userId = message.from?.id;

    // handle commands
    if (message.text && message.text.startsWith("/help")) {
      await sendTelegramMessage(chatId, "Sende eine Idee als Text oder Sprachmemo. /reset nicht implementiert lokal.");
      return res.sendStatus(200);
    }

    // Text message
    if (message.text) {
      await processIdeaText(message.text, chatId, userId);
      return res.sendStatus(200);
    }

    // Voice message (Telegram voice: OGG/OPUS)
    if (message.voice) {
      // 1) get file path
      const fileId = message.voice.file_id;
        const fRes = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
        const fJson = await fRes.json();

        // SAFETY CHECK
        if (!fJson.ok || !fJson.result || !fJson.result.file_path) {
            console.error("Telegram GetFile failed:", fJson);
            await sendTelegramMessage(chatId, "Konnte die Sprachnachricht nicht abrufen.");
            return res.sendStatus(200);
        }

        const filePath = fJson.result.file_path;

      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;

      // 2) download file as ArrayBuffer
      const dl = await fetch(fileUrl);
      const arrayBuffer = await dl.arrayBuffer();

      // 3) transcribe with Whisper
      const text = await transcribeAudioFromBuffer(arrayBuffer, "voice.oga");

      // 4) process as idea
      await processIdeaText(text, chatId, userId);
      return res.sendStatus(200);
    }

    // other types: ignore
    return res.sendStatus(200);
  } catch (err) {
    console.error("webhook error", err);
    res.sendStatus(500);
  }
});

app.get("/", (req, res) => res.send("Telegram AI Bot alive"));
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
