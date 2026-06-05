require("dotenv").config();
const express = require("express");
const cors = require("cors");
const nodemailer = require("nodemailer");

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";

// ─── Call Gemini API ──────────────────────────────────────────────────────────
async function askGemini(systemPrompt, history) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  // Convert history to Gemini format
  const contents = history.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 500, temperature: 0.7 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error: ${res.status} — ${err}`);
  }

  const data = await res.json();
  return data.candidates[0].content.parts[0].text;
}

// ─── Email transporter (Gmail) ────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.ALERT_EMAIL_FROM,
    pass: process.env.ALERT_EMAIL_PASSWORD,
  },
});

// ─── Escalation detection ─────────────────────────────────────────────────────
const ESCALATION_PHRASES = [
  "speak to a person",
  "speak to someone",
  "human agent",
  "real person",
  "talk to someone",
  "agent please",
  "live agent",
  "customer service",
  "not helpful",
  "useless",
  "this is frustrating",
  "i'm frustrated",
  "not working",
];

function needsEscalation(message, aiReply) {
  const msgLower = message.toLowerCase();
  const askedForHuman = ESCALATION_PHRASES.some((p) => msgLower.includes(p));
  const aiUncertain =
    /i('m| am) not sure|i don't know|i cannot|i can't answer|unclear|you may want to contact|please reach out/i.test(
      aiReply
    );
  return { escalate: askedForHuman || aiUncertain, askedForHuman, aiUncertain };
}

// ─── Send escalation email ────────────────────────────────────────────────────
async function sendEscalationEmail(conversation, reason) {
  const transcript = conversation
    .map((m) => `${m.role === "user" ? "Visitor" : "AI"}: ${m.content}`)
    .join("\n\n");

  const reasonText = reason.askedForHuman
    ? "Visitor requested a human agent."
    : "AI was uncertain and flagged the conversation.";

  await mailer.sendMail({
    from: process.env.ALERT_EMAIL_FROM,
    to: process.env.ALERT_EMAIL_TO,
    subject: "⚠️ Chat Escalation — Visitor Needs Help",
    text: `A visitor needs human assistance.\n\nReason: ${reasonText}\n\n──────────────────\nTRANSCRIPT\n──────────────────\n\n${transcript}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;padding:24px;">
        <h2 style="color:#c0392b;">⚠️ Chat Escalation Alert</h2>
        <p style="color:#666;">A visitor needs human assistance on your website.</p>
        <div style="background:#fff3cd;border-left:4px solid #f39c12;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
          <strong>Reason:</strong> ${reasonText}
        </div>
        <h3 style="border-bottom:1px solid #eee;padding-bottom:8px;">Conversation Transcript</h3>
        ${conversation
          .map(
            (m) => `
          <div style="margin-bottom:12px;">
            <span style="font-size:11px;font-weight:600;color:${m.role === "user" ? "#2980b9" : "#27ae60"};text-transform:uppercase;letter-spacing:1px;">
              ${m.role === "user" ? "Visitor" : "AI Assistant"}
            </span>
            <div style="background:${m.role === "user" ? "#eaf4fb" : "#eafaf1"};border-radius:8px;padding:10px 14px;margin-top:4px;font-size:14px;line-height:1.5;">
              ${m.content}
            </div>
          </div>`
          )
          .join("")}
        <p style="color:#999;font-size:12px;margin-top:24px;">Sent by your AI Chat system.</p>
      </div>
    `,
  });
}

// ─── Chat endpoint ────────────────────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: "No message provided" });

  const systemPrompt =
    process.env.SYSTEM_PROMPT ||
    `You are a helpful, friendly customer support assistant for this website.
Answer questions clearly and concisely.
If you genuinely don't know the answer or need account-specific details you can't access, say so honestly.
Keep replies short — 2-4 sentences unless more detail is needed.`;

  // Build full message history including new message
  const fullHistory = [
    ...history,
    { role: "user", content: message },
  ];

  try {
    const aiReply = await askGemini(systemPrompt, fullHistory);

    const { escalate, askedForHuman, aiUncertain } = needsEscalation(message, aiReply);

    let escalated = false;
    if (escalate) {
      try {
        await sendEscalationEmail(fullHistory.concat([{ role: "assistant", content: aiReply }]), {
          askedForHuman,
          aiUncertain,
        });
        escalated = true;
      } catch (emailErr) {
        console.error("Email send failed:", emailErr.message);
      }
    }

    res.json({
      reply: aiReply,
      escalated,
      escalationReason: escalated
        ? askedForHuman
          ? "human_requested"
          : "ai_uncertain"
        : null,
    });
  } catch (err) {
    console.error("Gemini error:", err.message);
    res.status(500).json({ error: "AI service error. Please try again." });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", model: GEMINI_MODEL }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () =>
  console.log(`AI Chat server (Gemini) running on port ${PORT}`)
);
