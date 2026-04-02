/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║         DevReview — Vercel-Optimized Backend API                ║
 * ║              Production-Ready v3.1.0 for Vercel                 ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  POST /api/review                                               ║
 * ║  GET  /health                                                    ║
 * ║  Supported: python · javascript · cpp · java · c · go           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

// ─── Imports ──────────────────────────────────────────────────────────────────
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://devrewiewom-smsz.vercel.app";
const QWEN_API_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_MODEL = process.env.QWEN_MODEL || "qwen-plus";

// Configuration limits
const MAX_CODE_LEN = 20000;           // characters
const MAX_TOKENS_ESTIMATE = 4000;     // Qwen token limit
const CODE_TRIM_LEN = 15000;          // Trim to this length to stay under token limit
const MAX_REQUESTS_PER_IP = 100;      // Increased for free tier testing
const RATE_LIMIT_WINDOW = 15;         // minutes
const CACHE_TTL = 3600000;            // 1 hour cache for repeated code reviews
const MAX_CACHE_SIZE = 100;           // Maximum cache entries

// Supported languages
const SUPPORTED_LANGS = ["python", "javascript", "cpp", "java", "c", "go"];

// Simple in-memory cache (Vercel supports this per instance)
const reviewCache = new Map();

// ─── Validation at Startup ───────────────────────────────────────────────────
console.log("\n🔍 Validating environment...");

if (!QWEN_API_KEY) {
  console.error("❌ ERROR: QWEN_API_KEY environment variable is not set!");
  console.error("   Please set it in Vercel environment variables.");
}

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// ─── CORS Configuration ──────────────────────────────────────────────────────
const allowedOrigins = FRONTEND_ORIGIN.split(',').map(o => o.trim());

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      console.warn(`Blocked CORS request from: ${origin}`);
      callback(null, false);
    }
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 86400
}));

// ─── Rate Limiting (Adjusted for free tier) ─────────────────────────────────
const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW * 60 * 1000,
  max: MAX_REQUESTS_PER_IP,
  message: { 
    error: "Too many requests", 
    message: `Rate limit exceeded. Please try again after ${RATE_LIMIT_WINDOW} minutes.` 
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Optional: Skip rate limiting for health checks
    return req.path === "/health";
  }
});

app.use(limiter);

// ─── Body Parsing & Security ────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Security headers only (removed setTimeout - handled by Vercel)
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  next();
});

// ─── Input Validation Helpers ──────────────────────────────────────────────
function validateCode(code) {
  if (!code || typeof code !== "string") {
    throw new Error("Code must be a non-empty string");
  }
  
  const trimmed = code.trim();
  if (!trimmed) {
    throw new Error("Code cannot be empty");
  }
  
  if (trimmed.length > MAX_CODE_LEN) {
    throw new Error(`Code exceeds ${MAX_CODE_LEN} character limit (current: ${trimmed.length})`);
  }
  
  return trimmed;
}

function validateLanguage(language) {
  if (!language || typeof language !== "string") {
    throw new Error("Language is required");
  }
  
  const lang = language.toLowerCase().trim();
  if (!SUPPORTED_LANGS.includes(lang)) {
    throw new Error(`Unsupported language "${lang}". Supported: ${SUPPORTED_LANGS.join(", ")}`);
  }
  
  return lang;
}

// ─── Token Estimation & Code Trimming ──────────────────────────────────────
function estimateTokens(text) {
  // Rough estimation: ~4 chars per token for code
  return Math.ceil(text.length / 4);
}

function trimCodeForTokens(code, maxTokens = MAX_TOKENS_ESTIMATE) {
  const estimatedTokens = estimateTokens(code);
  
  if (estimatedTokens <= maxTokens) {
    return { code, trimmed: false, originalLength: code.length };
  }
  
  // Trim to safe length (leave room for prompts)
  const safeLength = Math.floor(maxTokens * 3.5); // ~3.5 chars per token average
  const trimmedCode = code.substring(0, safeLength);
  
  return {
    code: trimmedCode + "\n\n// [Note: Code was truncated due to length limits]",
    trimmed: true,
    originalLength: code.length,
    trimmedLength: trimmedCode.length
  };
}

// ─── Cache Helpers ─────────────────────────────────────────────────────────
function getCacheKey(code, language) {
  const hash = crypto.createHash('md5').update(`${language}:${code}`).digest('hex');
  return hash;
}

function getCachedReview(key) {
  const cached = reviewCache.get(key);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  if (cached) {
    reviewCache.delete(key);
  }
  return null;
}

function setCachedReview(key, data) {
  // Clean up old cache entries if size exceeds limit
  if (reviewCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = reviewCache.keys().next().value;
    reviewCache.delete(oldestKey);
  }
  
  reviewCache.set(key, {
    data,
    timestamp: Date.now()
  });
}

// ─── Qwen API Integration (using native fetch) ─────────────────────────────
async function callQwenAPI(code, language) {
  if (!QWEN_API_KEY) {
    throw new Error("QWEN_API_KEY is not configured");
  }

  // Trim code if needed to stay within token limits
  const { code: processedCode, trimmed } = trimCodeForTokens(code);
  
  if (trimmed) {
    console.log(`⚠️ Code trimmed from ${code.length} to ${processedCode.length} chars to stay within token limits`);
  }

  const systemPrompt = `You are an expert code reviewer specializing in ${language}. 
Analyze the provided code and return ONLY a valid JSON object with no markdown, no backticks, no additional text.

The JSON must contain exactly these five keys:
- "bugs": array of strings describing bugs or logic errors (include line numbers when possible)
- "security_issues": array of strings describing security vulnerabilities
- "performance_tips": array of strings describing performance improvements
- "clean_code_suggestions": array of strings describing readability/maintainability improvements
- "rewritten_code": a single string containing the full rewritten code with ALL issues fixed

Each array may be empty []. The rewritten_code must always contain valid code.
Return raw JSON only.`;

  const userPrompt = `Language: ${language}

=== CODE TO REVIEW ===
${processedCode}

Provide a comprehensive code review following the JSON format exactly.`;

  try {
    const response = await fetch(QWEN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Qwen API error ${response.status}:`, errorText);
      throw new Error(`Qwen API returned ${response.status}`);
    }

    const data = await response.json();
    const rawContent = data?.choices?.[0]?.message?.content || "";
    
    // Parse JSON response (no need for extensive cleaning - Qwen returns clean JSON)
    try {
      const parsed = JSON.parse(rawContent);
      
      // Ensure all required fields exist
      const result = {
        bugs: Array.isArray(parsed.bugs) ? parsed.bugs : [],
        security_issues: Array.isArray(parsed.security_issues) ? parsed.security_issues : [],
        performance_tips: Array.isArray(parsed.performance_tips) ? parsed.performance_tips : [],
        clean_code_suggestions: Array.isArray(parsed.clean_code_suggestions) ? parsed.clean_code_suggestions : [],
        rewritten_code: typeof parsed.rewritten_code === "string" ? parsed.rewritten_code : code,
        was_trimmed: trimmed // Add flag to indicate if code was trimmed
      };
      
      return result;
    } catch (parseError) {
      console.error("Failed to parse Qwen response:", parseError.message);
      console.debug("Raw response (first 500 chars):", rawContent.substring(0, 500));
      
      // Return fallback response
      return {
        bugs: ["Unable to parse AI response. Please try again."],
        security_issues: [],
        performance_tips: [],
        clean_code_suggestions: [],
        rewritten_code: code,
        was_trimmed: trimmed
      };
    }
  } catch (error) {
    console.error("Qwen API call failed:", error.message);
    throw new Error(`AI review service error: ${error.message}`);
  }
}

// ─── Main Review Endpoint ──────────────────────────────────────────────────
app.post("/api/review", async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    const { code, language } = req.body;
    
    // Input validation
    const validatedCode = validateCode(code);
    const validatedLang = validateLanguage(language);
    
    console.log(`[${requestId}] Processing ${validatedLang} code review (${validatedCode.length} chars)`);
    
    // Check cache first
    const cacheKey = getCacheKey(validatedCode, validatedLang);
    const cachedReview = getCachedReview(cacheKey);
    
    if (cachedReview) {
      console.log(`[${requestId}] Returning cached review`);
      return res.status(200).json(cachedReview);
    }
    
    // Call Qwen API for review
    const review = await callQwenAPI(validatedCode, validatedLang);
    
    // Calculate summary
    const summary = {
      bugs: review.bugs.length,
      security: review.security_issues.length,
      perf: review.performance_tips.length,
      clean: review.clean_code_suggestions.length,
    };
    
    // Prepare response
    const response = {
      language: validatedLang,
      summary,
      static_issues: [],
      runtime: {
        output: null,
        error: review.was_trimmed ? "Code was truncated for analysis due to length limits" : null,
      },
      ai_review: {
        bugs: review.bugs,
        security_issues: review.security_issues,
        performance_tips: review.performance_tips,
        clean_code_suggestions: review.clean_code_suggestions,
        rewritten_code: review.rewritten_code,
      },
    };
    
    // Cache the response
    setCachedReview(cacheKey, response);
    
    console.log(`[${requestId}] Review completed successfully (${summary.bugs} bugs, ${summary.security} security issues)`);
    return res.status(200).json(response);
    
  } catch (error) {
    console.error(`[${requestId}] Error:`, error.message);
    
    // Handle different error types with appropriate status codes
    if (error.message.includes("exceeds") || error.message.includes("Unsupported")) {
      return res.status(400).json({ 
        error: error.message,
        requestId 
      });
    }
    
    if (error.message.includes("QWEN_API_KEY")) {
      return res.status(503).json({ 
        error: "Service temporarily unavailable",
        message: "API key not configured",
        requestId 
      });
    }
    
    // Generic error response (no stack traces exposed)
    return res.status(500).json({ 
      error: "Internal server error",
      message: "Please try again later",
      requestId 
    });
  }
});

// ─── Health Check Endpoint (optimized - no API calls) ─────────────────────
app.get("/health", async (_req, res) => {
  const health = {
    status: "ok",
    version: "3.1.0",
    timestamp: new Date().toISOString(),
    environment: "vercel",
    supported_languages: SUPPORTED_LANGS,
    cache_stats: {
      size: reviewCache.size,
      max_size: MAX_CACHE_SIZE,
      ttl_hours: CACHE_TTL / 3600000
    },
    configuration: {
      qwen_api_key: QWEN_API_KEY ? "configured" : "missing",
      qwen_model: QWEN_MODEL,
      max_code_length: MAX_CODE_LEN,
      rate_limit: `${MAX_REQUESTS_PER_IP}/${RATE_LIMIT_WINDOW}min`,
    }
  };
  
  // Only check API key existence, don't make actual calls
  if (!QWEN_API_KEY) {
    health.status = "degraded";
    health.warning = "QWEN_API_KEY not configured";
  }
  
  res.json(health);
});

// ─── Cache Stats Endpoint (optional, for monitoring) ───────────────────────
app.get("/api/cache/stats", (_req, res) => {
  res.json({
    size: reviewCache.size,
    max_size: MAX_CACHE_SIZE,
    ttl_hours: CACHE_TTL / 3600000,
    keys: Array.from(reviewCache.keys()).slice(0, 10) // Show first 10 keys only
  });
});

// ─── Root Endpoint ────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.json({
    name: "DevReview API",
    version: "3.1.0",
    status: "operational",
    endpoints: {
      review: "POST /api/review",
      health: "GET /health",
      cache_stats: "GET /api/cache/stats",
    },
    documentation: "https://github.com/yourusername/devreview",
  });
});

// ─── 404 Handler ───────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ 
    error: "Not found",
    message: "The requested endpoint does not exist"
  });
});

// ─── Error Handler (no stack trace exposure) ──────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.stack || err.message);
  res.status(500).json({ 
    error: "Internal server error",
    message: "Please try again later"
  });
});

// ─── Vercel Export ─────────────────────────────────────────────────────────
// For local development
if (process.env.NODE_ENV !== "production") {
  app.listen(PORT, () => {
    console.log(`\n  ╔═══════════════════════════════════════╗`);
    console.log(`  ║   DevReview API v3.1.0 — Vercel Ready   ║`);
    console.log(`  ╚═══════════════════════════════════════╝`);
    console.log(`  URL     : http://localhost:${PORT}`);
    console.log(`  CORS    : ${FRONTEND_ORIGIN}`);
    console.log(`  Model   : ${QWEN_MODEL}`);
    console.log(`  Langs   : ${SUPPORTED_LANGS.join(" · ")}`);
    console.log(`  Cache   : ${MAX_CACHE_SIZE} entries, ${CACHE_TTL / 3600000}h TTL\n`);
  });
}

// Export for Vercel serverless functions
export default app;
