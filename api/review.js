import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": process.env.SITE_URL || "https://devreview.vercel.app",
    "X-Title": "DevReview",
  },
});

function buildPrompt(language, code) {
  return `You are an expert software engineer and security specialist conducting a professional code review.

Analyze the following ${language} code thoroughly and return your review in this exact structured format using these section headers:

## BUGS / ERRORS
List every bug, logic error, null/undefined risk, type mismatch, or exception. 
One issue per line starting with •. Include line numbers where possible.
If none: write "— No bugs detected."

## SECURITY ISSUES
List every security vulnerability: injection risks, exposed secrets, insecure dependencies, 
missing auth checks, OWASP Top-10 issues, unsafe deserialization, etc.
One issue per line starting with •. Include severity (HIGH/MEDIUM/LOW).
If none: write "— No security issues found."

## PERFORMANCE TIPS
List every performance problem: algorithmic inefficiency (O(n²), etc.), memory leaks, 
redundant computations, unnecessary re-renders, N+1 queries, blocking calls, etc.
One issue per line starting with •.
If none: write "— No performance issues found."

## CLEAN CODE SUGGESTIONS
List code quality improvements: naming conventions, function decomposition, 
dead code, readability, DRY violations, missing error handling, best practices.
One issue per line starting with •.
If none: write "— Code quality looks good."

## REWRITTEN CODE
Provide a complete, production-ready rewrite of the code in ${language}.
Fix all bugs, security issues, and performance problems identified above.
Apply clean code principles. Include only the code — no explanation or commentary.

---

Code to review (${language}):
\`\`\`${language}
${code}
\`\`\``;
}

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed. Use POST." });
  }

  // Parse body
  const { language, code } = req.body || {};

  // Validate inputs
  if (!language || typeof language !== "string" || !language.trim()) {
    return res.status(400).json({ error: 'Missing or invalid "language" field.' });
  }

  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: 'Missing or invalid "code" field.' });
  }

  if (code.length > 20000) {
    return res.status(400).json({ error: "Code exceeds maximum allowed length of 20,000 characters." });
  }

  // Check API key
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("[DevReview] OPENROUTER_API_KEY is not set.");
    return res.status(500).json({ error: "Server configuration error: missing API key." });
  }

  try {
    const completion = await client.chat.completions.create({
      model: "qwen/qwen-2.5-72b-instruct",
      messages: [
        {
          role: "system",
          content:
            "You are a senior software engineer and security expert with 15+ years of experience. " +
            "You provide thorough, accurate, and actionable code reviews. " +
            "You always follow the exact output format requested by the user.",
        },
        {
          role: "user",
          content: buildPrompt(language.trim(), code.trim()),
        },
      ],
      temperature: 0.2,
      max_tokens: 4000,
    });

    const review = completion.choices?.[0]?.message?.content?.trim();

    if (!review) {
      return res.status(502).json({ error: "AI returned an empty response. Please try again." });
    }

    return res.status(200).json({ review });

  } catch (err) {
    console.error("[DevReview API Error]", err?.message || err);

    // OpenAI SDK surfaces HTTP errors with a .status property
    const status = err?.status || err?.response?.status;

    if (status === 401) {
      return res.status(500).json({ error: "Invalid API key. Check your OPENROUTER_API_KEY." });
    }
    if (status === 429) {
      return res.status(429).json({ error: "Rate limit reached. Please wait a moment and try again." });
    }
    if (status === 402) {
      return res.status(402).json({ error: "OpenRouter account has insufficient credits." });
    }
    if (status >= 500) {
      return res.status(502).json({ error: "OpenRouter service is currently unavailable. Try again shortly." });
    }

    return res.status(500).json({
      error: "Code review failed.",
      detail: err?.message || "Unknown error",
    });
  }
}
