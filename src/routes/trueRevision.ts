import { GoogleGenAI, Type } from "@google/genai";
import { Router } from "express";

const router = Router();

function getGenAI(): GoogleGenAI {
  const key = process.env["GEMINI_API_KEY"];
  if (!key) throw new Error("GEMINI_API_KEY is not set.");
  return new GoogleGenAI({ apiKey: key });
}

// Rate limiter: 30 requests per IP per 5 minutes
const requestCounts = new Map<string, { count: number; windowStart: number }>();
const RATE_WINDOW = 5 * 60 * 1000;
const MAX_REQUESTS = 30;

function rateLimiter(req: any, res: any, next: any) {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    "anon";
  const now = Date.now();
  const existing = requestCounts.get(ip);
  if (!existing || now - existing.windowStart > RATE_WINDOW) {
    requestCounts.set(ip, { count: 1, windowStart: now });
    return next();
  }
  if (existing.count >= MAX_REQUESTS) {
    return res
      .status(429)
      .json({ error: "Too many requests. Please wait a few minutes." });
  }
  existing.count++;
  next();
}

// POST /api/tr/generate — generate MCQ questions from text
router.post("/generate", rateLimiter, async (req, res) => {
  try {
    const { documentText, examMode, qty, documentName, batchIndex } = req.body;

    if (
      !documentText ||
      typeof documentText !== "string" ||
      documentText.trim().length < 30
    ) {
      return res
        .status(400)
        .json({ error: "documentText must be at least 30 characters." });
    }
    if (!examMode || typeof examMode !== "string") {
      return res.status(400).json({ error: "examMode is required." });
    }

    const count = Math.min(Math.max(parseInt(qty) || 5, 1), 20);
    const batchNum = parseInt(batchIndex) || 0;
    const textSlice = documentText.substring(0, 6000);

    const genai = getGenAI();

    const prompt = `You are an expert ${examMode} exam question creator.
Generate exactly ${count} UNIQUE high-quality multiple choice questions from the study material below.
${batchNum > 0 ? `This is batch ${batchNum + 1} — generate DIFFERENT questions from previous batches, covering different sub-topics.` : ""}

Study Material:
"""
${textSlice}
"""
Chapter: "${documentName || "Study Material"}"
Exam Mode: ${examMode}

Rules:
- Each question MUST test conceptual understanding, not rote memorization
- 4 options only (A, B, C, D), exactly one correct
- Explanation: 1-2 sentences WHY the answer is correct
- Topic: short keyword phrase (e.g. "Photosynthesis", "Newton's Laws")
- correctAnswer MUST be one of: "A", "B", "C", "D"
- Do NOT repeat questions from other batches
- Make difficulty appropriate for ${examMode} competitive exams

Return a JSON array of exactly ${count} objects.`;

    const response = await genai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              question: { type: Type.STRING },
              optionA: { type: Type.STRING },
              optionB: { type: Type.STRING },
              optionC: { type: Type.STRING },
              optionD: { type: Type.STRING },
              correctAnswer: { type: Type.STRING },
              explanation: { type: Type.STRING },
              topic: { type: Type.STRING },
            },
            required: [
              "question",
              "optionA",
              "optionB",
              "optionC",
              "optionD",
              "correctAnswer",
              "explanation",
              "topic",
            ],
          },
        },
      },
    });

    const text = response.text ?? "[]";
    let questions: any[];
    try {
      questions = JSON.parse(text);
    } catch {
      return res
        .status(500)
        .json({ error: "Failed to parse AI response. Please try again." });
    }

    const valid = questions
      .filter(
        (q) =>
          q.question &&
          q.optionA &&
          q.optionB &&
          q.optionC &&
          q.optionD &&
          ["A", "B", "C", "D"].includes(q.correctAnswer)
      )
      .slice(0, count);

    return res.json({ questions: valid, count: valid.length });
  } catch (err: any) {
    console.error("[TrueRevision] generate error:", err.message);
    return res
      .status(500)
      .json({ error: err.message || "Internal server error" });
  }
});

// POST /api/tr/ocr — extract text from base64 image via Gemini Vision
router.post("/ocr", rateLimiter, async (req, res) => {
  try {
    const { base64Image, mimeType } = req.body;

    if (!base64Image || typeof base64Image !== "string") {
      return res.status(400).json({ error: "base64Image is required." });
    }

    const validMimes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif",
    ];
    const mime =
      mimeType && validMimes.includes(mimeType) ? mimeType : "image/jpeg";
    const genai = getGenAI();

    const response = await genai.models.generateContent({
      model: "gemini-2.0-flash",
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mime, data: base64Image } },
            {
              text: "Extract all text from this textbook/study material image. Return only clean extracted text preserving paragraph structure. Do not add any commentary.",
            },
          ],
        },
      ],
    });

    return res.json({ text: (response.text ?? "").trim() });
  } catch (err: any) {
    console.error("[TrueRevision] OCR error:", err.message);
    return res.status(500).json({ error: err.message || "OCR failed" });
  }
});

// POST /api/tr/extract-doc — extract text from PDF or text file
router.post("/extract-doc", rateLimiter, async (req, res) => {
  try {
    const { base64File, mimeType, fileName } = req.body;

    if (!base64File || typeof base64File !== "string") {
      return res.status(400).json({ error: "base64File is required." });
    }

    const fileBuffer = Buffer.from(base64File, "base64");
    let extractedText = "";
    const genai = getGenAI();

    const isTextFile =
      mimeType === "text/plain" ||
      mimeType === "text/markdown" ||
      (fileName && (fileName as string).match(/\.(txt|md|text|csv)$/i));

    if (isTextFile) {
      extractedText = fileBuffer.toString("utf-8");
    } else {
      const fileMime =
        mimeType ||
        ((fileName as string)?.toLowerCase().endsWith(".pdf")
          ? "application/pdf"
          : "application/octet-stream");
      try {
        const response = await genai.models.generateContent({
          model: "gemini-2.0-flash",
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: fileMime, data: base64File } },
                {
                  text: "Extract all text content from this document. Return only the clean text, preserving paragraph and heading structure. Do not add any commentary.",
                },
              ],
            },
          ],
        });
        extractedText = response.text ?? "";
      } catch (err: any) {
        console.error(
          "[TrueRevision] Gemini doc extraction error:",
          err.message
        );
        return res
          .status(500)
          .json({ error: "Could not extract text from document." });
      }
    }

    const cleaned = extractedText
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!cleaned || cleaned.length < 20) {
      return res
        .status(422)
        .json({ error: "No readable text found in the document." });
    }

    return res.json({ text: cleaned, charCount: cleaned.length });
  } catch (err: any) {
    console.error("[TrueRevision] extract-doc error:", err.message);
    return res
      .status(500)
      .json({ error: err.message || "Document extraction failed" });
  }
});

// GET /api/tr/health
router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    geminiConfigured: !!process.env["GEMINI_API_KEY"],
  });
});

export default router;
