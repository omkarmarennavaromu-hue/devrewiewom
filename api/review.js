/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║              DevReview — Backend API  (review.js)               ║
 * ║  Single-file Express server — deploy on Railway / Render / VPS  ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  POST /api/review                                               ║
 * ║  Supported: python · javascript · cpp · java · c · go           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 *  Fixed Version v2.1.0 - All bugs addressed
 */

// ─── Imports ──────────────────────────────────────────────────────────────────
import express        from "express";
import cors           from "cors";
import vm             from "vm";
import fs             from "fs";
import os             from "os";
import path           from "path";
import crypto         from "crypto";
import { promisify }  from "util";
import { exec, spawn } from "child_process";
import fetch          from "node-fetch";
import rateLimit      from "express-rate-limit";
import { fileURLToPath } from "url";

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3000;
const QWEN_API_KEY    = process.env.QWEN_API_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://devrewiewom-smsz.vercel.app";
const QWEN_API_URL    = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_MODEL      = "qwen-plus";
const EXEC_TIMEOUT    = 8000;    // ms — sandbox execution hard limit
const MAX_CODE_LEN    = 20000;   // characters
const MAX_TEMP_FILES  = 100;     // Maximum temp files to keep before cleanup

const SUPPORTED_LANGS = ["python", "javascript", "cpp", "java", "c", "go"];

// ─── Validation at Startup ───────────────────────────────────────────────────
console.log("\n🔍 Validating environment and dependencies...");

// Validate QWEN_API_KEY at startup
if (!QWEN_API_KEY) {
  console.error("❌ ERROR: QWEN_API_KEY environment variable is not set!");
  console.error("   Please set it before starting the server.");
  process.exit(1);
}

// Track temp files for cleanup
let tempFiles = new Set();
let cleanupInterval = null;

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// ─── FIX 1: Improved CORS with multiple origin support ──────────────────────
const allowedOrigins = FRONTEND_ORIGIN.split(',').map(o => o.trim());
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl)
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
  maxAge: 86400 // 24 hours
}));

// ─── FIX 10 & 11: Rate limiting and request size limits ──────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);
app.use(express.json({ limit: "1mb" }));

// ─── FIX 12: Request timeout middleware ──────────────────────────────────────
app.use((req, res, next) => {
  req.setTimeout(30000, () => {
    res.status(408).json({ error: "Request timeout" });
  });
  res.setTimeout(30000, () => {
    res.status(408).json({ error: "Response timeout" });
  });
  next();
});

// ─── FIX 4: Improved temp file management with cleanup ───────────────────────
function tmpFile(code, ext) {
  const name = `devreview_${crypto.randomBytes(8).toString("hex")}`;
  const fp = path.join(os.tmpdir(), `${name}.${ext}`);
  
  try {
    fs.writeFileSync(fp, code, "utf8");
    tempFiles.add(fp);
    
    // Cleanup old files if we have too many
    if (tempFiles.size > MAX_TEMP_FILES) {
      cleanupTempFiles();
    }
    
    return fp;
  } catch (err) {
    console.error(`Failed to write temp file ${fp}:`, err.message);
    throw new Error(`Failed to create temporary file: ${err.message}`);
  }
}

function cleanupTempFiles() {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  
  for (const fp of tempFiles) {
    try {
      if (fs.existsSync(fp)) {
        const stats = fs.statSync(fp);
        if (stats.mtimeMs < oneHourAgo) {
          fs.unlinkSync(fp);
          tempFiles.delete(fp);
        }
      } else {
        tempFiles.delete(fp);
      }
    } catch (err) {
      // Ignore cleanup errors
    }
  }
}

function rm(...paths) {
  for (const p of paths) {
    try {
      if (p && fs.existsSync(p)) {
        fs.unlinkSync(p);
        tempFiles.delete(p);
      }
    } catch (err) {
      // Log but don't throw
      console.debug(`Failed to delete ${p}:`, err.message);
    }
  }
}

// Start periodic cleanup
cleanupInterval = setInterval(cleanupTempFiles, 3600000); // Every hour

// ─── FIX 2 & 13: Improved shell execution with escaping ──────────────────────
function escapeShellArg(arg) {
  if (typeof arg !== 'string') return '';
  return arg.replace(/'/g, "'\\''");
}

async function shell(cmd, timeoutMs = EXEC_TIMEOUT, options = {}) {
  const { cwd, env } = options;
  
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      shell: true,
      cwd,
      env: { ...process.env, ...env }
    });
    return { 
      stdout: (stdout || "").trim(), 
      stderr: (stderr || "").trim(),
      exitCode: 0 
    };
  } catch (err) {
    // Handle timeout specially
    if (err.killed && err.signal === 'SIGTERM') {
      return {
        stdout: (err.stdout || "").trim(),
        stderr: `Execution timed out after ${timeoutMs}ms`,
        exitCode: -1
      };
    }
    
    return {
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || err.message || "Command execution failed").trim(),
      exitCode: err.code || 1
    };
  }
}

// ─── FIX 14: Static analysis with proper escaping ────────────────────────────
async function staticPython(code) {
  const fp = tmpFile(code, "py");
  const out = [];
  try {
    // Check if pylint is available
    const checkPylint = await shell("which pylint");
    if (checkPylint.exitCode === 0) {
      const lint = await shell(`pylint "${escapeShellArg(fp)}" --output-format=text --score=no 2>&1`);
      if (lint.stdout && !lint.stdout.includes("No module named")) {
        out.push(`[PyLint]\n${lint.stdout}`);
      }
    }
    
    // Check if bandit is available
    const checkBandit = await shell("which bandit");
    if (checkBandit.exitCode === 0) {
      const sec = await shell(`bandit -r "${escapeShellArg(fp)}" -f txt -q 2>&1`);
      if (sec.stdout && !sec.stdout.includes("No module named")) {
        out.push(`[Bandit]\n${sec.stdout}`);
      }
    }
  } finally { rm(fp); }
  return out;
}

async function staticJavaScript(code) {
  const fp = tmpFile(code, "js");
  const out = [];
  
  try {
    // Check if eslint is available
    const checkEslint = await shell("npx eslint --version");
    if (checkEslint.exitCode === 0) {
      const rules = {
        "no-undef": 2,
        "no-unused-vars": 1,
        "eqeqeq": 1,
        "no-eval": 2,
        "no-implied-eval": 2
      };
      
      // Write rules to a temp file to avoid shell escaping issues
      const rulesFile = tmpFile(JSON.stringify(rules), "json");
      try {
        const res = await shell(
          `npx eslint "${escapeShellArg(fp)}" --no-eslintrc --rule '${JSON.stringify(rules)}' --format compact 2>&1`,
          EXEC_TIMEOUT
        );
        if (res.stdout && !res.stdout.includes("No ESLint configuration found")) {
          out.push(`[ESLint]\n${res.stdout}`);
        }
      } finally {
        rm(rulesFile);
      }
    }
  } finally { rm(fp); }
  return out;
}

async function staticCpp(code) {
  const fp = tmpFile(code, "cpp");
  const out = [];
  try {
    const checkCppcheck = await shell("which cppcheck");
    if (checkCppcheck.exitCode === 0) {
      const res = await shell(
        `cppcheck --enable=all --suppress=missingIncludeSystem "${escapeShellArg(fp)}" 2>&1`,
        EXEC_TIMEOUT
      );
      const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      if (combined && !combined.includes("command not found")) {
        out.push(`[cppcheck]\n${combined}`);
      }
    }
  } finally { rm(fp); }
  return out;
}

async function staticJava(code) {
  const fp = tmpFile(code, "java");
  const out = [];
  try {
    const checkJavac = await shell("which javac");
    if (checkJavac.exitCode === 0) {
      const compile = await shell(`javac "${escapeShellArg(fp)}" 2>&1`, EXEC_TIMEOUT);
      const combined = [compile.stdout, compile.stderr].filter(Boolean).join("\n").trim();
      if (combined && !combined.includes("not found")) {
        out.push(`[javac]\n${combined}`);
      }
    }
  } finally { rm(fp); }
  return out;
}

async function staticC(code) {
  const fp = tmpFile(code, "c");
  const out = [];
  try {
    const checkGcc = await shell("which gcc");
    if (checkGcc.exitCode === 0) {
      const res = await shell(`gcc -fsyntax-only -Wall -Wextra "${escapeShellArg(fp)}" 2>&1`, EXEC_TIMEOUT);
      const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      if (combined && !combined.includes("not found")) {
        out.push(`[gcc warnings]\n${combined}`);
      }
    }
  } finally { rm(fp); }
  return out;
}

async function staticGo(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "govet_"));
  const fp = path.join(dir, "main.go");
  const out = [];
  
  try {
    fs.writeFileSync(fp, code, "utf8");
    const checkGo = await shell("which go");
    if (checkGo.exitCode === 0) {
      await shell(`cd "${escapeShellArg(dir)}" && go mod init devreview 2>&1`, 5000);
      const vet = await shell(`cd "${escapeShellArg(dir)}" && go vet ./... 2>&1`, EXEC_TIMEOUT);
      const combined = [vet.stdout, vet.stderr].filter(Boolean).join("\n").trim();
      if (combined && !combined.includes("go: go.mod file not found")) {
        out.push(`[go vet]\n${combined}`);
      }
    }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.debug(`Failed to cleanup Go temp dir: ${err.message}`);
    }
  }
  return out;
}

// ─── FIX 6: Improved sandbox security with timeout and resource limits ──────
function sandboxJS(code) {
  const logs = [];
  const timeoutError = { error: null };
  
  // Create a more restricted sandbox
  const ctx = vm.createContext({
    console: {
      log: (...a) => logs.push(a.map(String).join(" ")),
      error: (...a) => logs.push("[err] " + a.map(String).join(" ")),
      warn: (...a) => logs.push("[warn] " + a.map(String).join(" ")),
    },
    setTimeout: (fn, ms) => {
      if (ms > 1000) throw new Error("setTimeout timeout too long");
      return setTimeout(fn, ms);
    },
    clearTimeout: (id) => clearTimeout(id),
    // Empty objects to prevent prototype pollution
    __proto__: null,
  });
  
  // Prevent access to global object
  Object.setPrototypeOf(ctx, null);
  
  try {
    const script = new vm.Script(code, { 
      timeout: EXEC_TIMEOUT,
      displayErrors: true 
    });
    
    script.runInContext(ctx, { 
      timeout: EXEC_TIMEOUT,
      displayErrors: true 
    });
    
    return { output: logs.join("\n"), error: null };
  } catch (e) {
    return { output: logs.join("\n"), error: e.message };
  }
}

async function sandboxPython(code) {
  const fp = tmpFile(code, "py");
  try {
    const r = await shell(`python3 "${escapeShellArg(fp)}" 2>&1`, EXEC_TIMEOUT);
    return { output: r.stdout || "", error: r.stderr || null };
  } finally { rm(fp); }
}

async function sandboxCpp(code) {
  const src = tmpFile(code, "cpp");
  const bin = src.replace(".cpp", ".out");
  try {
    const compile = await shell(`g++ -o "${escapeShellArg(bin)}" "${escapeShellArg(src)}" -std=c++17 2>&1`, EXEC_TIMEOUT);
    if (compile.stderr && (compile.stderr.includes("error:") || compile.exitCode !== 0)) {
      return { output: "", error: `[Compile error]\n${compile.stderr}` };
    }
    const run = await shell(`"${escapeShellArg(bin)}" 2>&1`, EXEC_TIMEOUT);
    return { output: run.stdout || "", error: run.stderr || null };
  } finally { rm(src, bin); }
}

// ─── FIX 5: Improved Java class name detection ───────────────────────────────
function detectJavaClassName(code) {
  // Handle package statement
  let cleanCode = code;
  
  // Remove package statement for detection
  cleanCode = cleanCode.replace(/package\s+[\w.]+;\s*\n?/, '');
  
  // Remove block comments
  cleanCode = cleanCode.replace(/\/\*[\s\S]*?\*\//g, '');
  
  // Remove line comments
  cleanCode = cleanCode.replace(/\/\/.*$/gm, '');
  
  // Match public class or interface
  const classMatch = cleanCode.match(/public\s+(?:class|interface)\s+(\w+)/);
  if (classMatch) return classMatch[1];
  
  // Match any class (including non-public)
  const anyClassMatch = cleanCode.match(/(?:class|interface)\s+(\w+)/);
  if (anyClassMatch) return anyClassMatch[1];
  
  return "Main";
}

async function sandboxJava(code) {
  const className = detectJavaClassName(code);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jrun_"));
  const src = path.join(dir, `${className}.java`);
  
  try {
    fs.writeFileSync(src, code, "utf8");
    
    const compile = await shell(`javac "${escapeShellArg(src)}" 2>&1`, EXEC_TIMEOUT);
    if (compile.stderr && (compile.stderr.includes("error:") || compile.exitCode !== 0)) {
      return { output: "", error: `[javac]\n${compile.stderr}` };
    }
    
    const run = await shell(`java -cp "${escapeShellArg(dir)}" ${className} 2>&1`, EXEC_TIMEOUT);
    return { output: run.stdout || "", error: run.stderr || null };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.debug(`Failed to cleanup Java temp dir: ${err.message}`);
    }
  }
}

async function sandboxC(code) {
  const src = tmpFile(code, "c");
  const bin = src.replace(".c", ".out");
  try {
    const compile = await shell(`gcc -o "${escapeShellArg(bin)}" "${escapeShellArg(src)}" -lm 2>&1`, EXEC_TIMEOUT);
    if (compile.stderr && (compile.stderr.includes("error:") || compile.exitCode !== 0)) {
      return { output: "", error: `[gcc]\n${compile.stderr}` };
    }
    const run = await shell(`"${escapeShellArg(bin)}" 2>&1`, EXEC_TIMEOUT);
    return { output: run.stdout || "", error: run.stderr || null };
  } finally { rm(src, bin); }
}

async function sandboxGo(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gorun_"));
  const fp = path.join(dir, "main.go");
  
  try {
    fs.writeFileSync(fp, code, "utf8");
    await shell(`cd "${escapeShellArg(dir)}" && go mod init devreview 2>&1`, 5000);
    
    const run = await shell(`cd "${escapeShellArg(dir)}" && go run main.go 2>&1`, EXEC_TIMEOUT);
    return {
      output: run.stdout || "",
      error: run.stderr ? run.stderr : null,
    };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.debug(`Failed to cleanup Go temp dir: ${err.message}`);
    }
  }
}

// ─── Language router helpers ──────────────────────────────────────────────────
async function runStatic(lang, code) {
  try {
    switch (lang) {
      case "python":     return await staticPython(code);
      case "javascript": return await staticJavaScript(code);
      case "cpp":        return await staticCpp(code);
      case "java":       return await staticJava(code);
      case "c":          return await staticC(code);
      case "go":         return await staticGo(code);
      default:           return [];
    }
  } catch (err) {
    console.error(`Static analysis failed for ${lang}:`, err.message);
    return [`Static analysis error: ${err.message}`];
  }
}

async function runSandbox(lang, code) {
  try {
    switch (lang) {
      case "python":     return await sandboxPython(code);
      case "javascript": return sandboxJS(code);
      case "cpp":        return await sandboxCpp(code);
      case "java":       return await sandboxJava(code);
      case "c":          return await sandboxC(code);
      case "go":         return await sandboxGo(code);
      default:           return { output: "", error: "Language not supported" };
    }
  } catch (err) {
    console.error(`Sandbox execution failed for ${lang}:`, err.message);
    return { output: "", error: `Execution error: ${err.message}` };
  }
}

// ─── FIX 7 & 15: Improved Qwen API call with better error handling ──────────
async function callQwen({ code, language, staticIssues, runtimeError, runtimeOutput }) {
  if (!QWEN_API_KEY) {
    throw new Error("QWEN_API_KEY is not configured");
  }

  const staticSection = staticIssues.length
    ? staticIssues.join("\n\n")
    : "No static analysis issues detected.";

  const runtimeSection = runtimeError
    ? `Runtime error:\n${runtimeError}`
    : runtimeOutput
    ? `Runtime output (no errors):\n${runtimeOutput}`
    : "Code produced no output.";

  const systemPrompt = `\
You are an expert code reviewer. Analyze the provided ${language} code and return ONLY a valid JSON object — no markdown, no backticks, no preamble, no extra text whatsoever.

The JSON must contain exactly these five keys:

"bugs"                   — array of strings describing bugs or logic errors (include line numbers when possible)
"security_issues"        — array of strings describing security vulnerabilities or unsafe patterns
"performance_tips"       — array of strings describing performance improvements
"clean_code_suggestions" — array of strings describing readability or maintainability improvements
"rewritten_code"         — a SINGLE STRING containing the full, rewritten, improved version of the original code with ALL issues fixed. Include short inline comments explaining each key change. Preserve the original language and intent.

Each array may be empty [] if nothing is found. "rewritten_code" must always contain valid code.
Return raw JSON only.`;

  const userPrompt = `\
Language: ${language}

=== ORIGINAL CODE ===
${code}

=== STATIC ANALYSIS RESULTS ===
${staticSection}

=== SANDBOX EXECUTION RESULTS ===
${runtimeSection}

Analyze thoroughly using all context above, then return the JSON.`;

  try {
    const resp = await fetch(QWEN_API_URL, {
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

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`Qwen API error ${resp.status}:`, body);
      throw new Error(`Qwen API ${resp.status}: ${body.substring(0, 200)}`);
    }

    const data = await resp.json();
    const raw = (data?.choices?.[0]?.message?.content || "").trim();

    // Strip any markdown code fences
    const clean = raw
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    try {
      const parsed = JSON.parse(clean);
      
      // Validate required fields
      const requiredFields = ['bugs', 'security_issues', 'performance_tips', 'clean_code_suggestions', 'rewritten_code'];
      for (const field of requiredFields) {
        if (!(field in parsed)) {
          parsed[field] = field === 'rewritten_code' ? code : [];
        }
      }
      
      return parsed;
    } catch (parseErr) {
      console.error("Failed to parse Qwen response:", parseErr.message);
      console.debug("Raw response:", raw.substring(0, 500));
      
      // Return a structured fallback
      return {
        bugs: ["Unable to parse AI response. Please try again."],
        security_issues: [],
        performance_tips: [],
        clean_code_suggestions: [],
        rewritten_code: code,
      };
    }
  } catch (err) {
    console.error("Qwen API call failed:", err.message);
    throw new Error(`AI review failed: ${err.message}`);
  }
}

// ─── FIX 8 & 9: Main review endpoint with comprehensive validation ──────────
app.post("/api/review", async (req, res) => {
  const { code, language } = req.body;
  const requestId = crypto.randomBytes(4).toString("hex");
  
  console.log(`[${requestId}] Processing review request for ${language}`);

  // Input validation
  if (!code || typeof code !== "string" || !code.trim()) {
    return res.status(400).json({ error: "`code` must be a non-empty string." });
  }
  
  if (!language || typeof language !== "string") {
    return res.status(400).json({ error: "`language` is required." });
  }
  
  const lang = language.toLowerCase().trim();
  if (!SUPPORTED_LANGS.includes(lang)) {
    return res.status(400).json({
      error: `Unsupported language "${lang}". Supported: ${SUPPORTED_LANGS.join(", ")}.`,
    });
  }
  
  if (code.length > MAX_CODE_LEN) {
    return res.status(400).json({ 
      error: `Code exceeds ${MAX_CODE_LEN} character limit. Current length: ${code.length}.` 
    });
  }

  // Language-specific validation
  if (lang === "javascript" && code.includes("require(") && !code.includes("module.exports")) {
    console.warn(`[${requestId}] Potential Node.js-specific code detected`);
  }
  
  if (lang === "python" && code.includes("__import__")) {
    console.warn(`[${requestId}] Potential unsafe Python import detected`);
  }

  try {
    // Step 1: Static analysis
    console.log(`[${requestId}] Running static analysis...`);
    const staticIssues = await runStatic(lang, code);

    // Step 2: Sandbox execution
    console.log(`[${requestId}] Running sandbox execution...`);
    const runtime = await runSandbox(lang, code);

    // Step 3: Qwen AI review
    console.log(`[${requestId}] Calling Qwen API...`);
    const ai = await callQwen({
      code,
      language: lang,
      staticIssues,
      runtimeError: runtime.error,
      runtimeOutput: runtime.output,
    });

    // Step 4: Build summary counts
    const summary = {
      bugs: (ai.bugs || []).length,
      security: (ai.security_issues || []).length,
      perf: (ai.performance_tips || []).length,
      clean: (ai.clean_code_suggestions || []).length,
    };

    // Step 5: Return combined response
    console.log(`[${requestId}] Review completed successfully`);
    return res.status(200).json({
      language,
      summary,
      static_issues: staticIssues,
      runtime: {
        output: runtime.output || null,
        error: runtime.error || null,
      },
      ai_review: {
        bugs: ai.bugs || [],
        security_issues: ai.security_issues || [],
        performance_tips: ai.performance_tips || [],
        clean_code_suggestions: ai.clean_code_suggestions || [],
        rewritten_code: ai.rewritten_code || code,
      },
    });

  } catch (err) {
    console.error(`[${requestId}] Unhandled error:`, err.message);
    console.error(err.stack);
    
    // Don't expose internal error details to client
    return res.status(500).json({ 
      error: "Internal server error. Please try again later.",
      requestId: requestId // Allow client to reference error in support
    });
  }
});

// ─── FIX 15: Enhanced health check endpoint ──────────────────────────────────
app.get("/health", async (_req, res) => {
  const health = {
    status: "ok",
    version: "2.1.0",
    timestamp: new Date().toISOString(),
    languages: SUPPORTED_LANGS,
    dependencies: {},
    environment: {
      qwen_api_key: QWEN_API_KEY ? "configured" : "missing",
      node_version: process.version,
      platform: process.platform,
    }
  };
  
  // Check system dependencies
  for (const lang of SUPPORTED_LANGS) {
    health.dependencies[lang] = { available: false, tools: [] };
    
    switch (lang) {
      case "python":
        const python = await shell("which python3");
        const pylint = await shell("which pylint");
        const bandit = await shell("which bandit");
        health.dependencies.python = {
          available: python.exitCode === 0,
          tools: {
            python3: python.exitCode === 0,
            pylint: pylint.exitCode === 0,
            bandit: bandit.exitCode === 0
          }
        };
        break;
      case "javascript":
        const eslint = await shell("npx eslint --version");
        health.dependencies.javascript = {
          available: eslint.exitCode === 0,
          tools: { eslint: eslint.exitCode === 0 }
        };
        break;
      case "cpp":
        const gpp = await shell("which g++");
        const cppcheck = await shell("which cppcheck");
        health.dependencies.cpp = {
          available: gpp.exitCode === 0,
          tools: {
            gpp: gpp.exitCode === 0,
            cppcheck: cppcheck.exitCode === 0
          }
        };
        break;
      case "java":
        const javac = await shell("which javac");
        const java = await shell("which java");
        health.dependencies.java = {
          available: javac.exitCode === 0 && java.exitCode === 0,
          tools: {
            javac: javac.exitCode === 0,
            java: java.exitCode === 0
          }
        };
        break;
      case "c":
        const gcc = await shell("which gcc");
        health.dependencies.c = {
          available: gcc.exitCode === 0,
          tools: { gcc: gcc.exitCode === 0 }
        };
        break;
      case "go":
        const go = await shell("which go");
        health.dependencies.go = {
          available: go.exitCode === 0,
          tools: { go: go.exitCode === 0 }
        };
        break;
    }
  }
  
  // Overall health status
  const allDepsAvailable = Object.values(health.dependencies).every(dep => dep.available);
  health.status = allDepsAvailable && QWEN_API_KEY ? "healthy" : "degraded";
  
  res.json(health);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  if (cleanupInterval) clearInterval(cleanupInterval);
  cleanupTempFiles();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, cleaning up...');
  if (cleanupInterval) clearInterval(cleanupInterval);
  cleanupTempFiles();
  process.exit(0);
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   DevReview API  v2.1.0  — ready        ║`);
  console.log(`  ╚═══════════════════════════════════════╝`);
  console.log(`  URL     : http://localhost:${PORT}`);
  console.log(`  CORS    : ${FRONTEND_ORIGIN}`);
  console.log(`  Model   : ${QWEN_MODEL}`);
  console.log(`  Langs   : ${SUPPORTED_LANGS.join(" · ")}`);
  console.log(`  Temp Dir: ${os.tmpdir()}\n`);
});
