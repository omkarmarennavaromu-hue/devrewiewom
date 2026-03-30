/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║              DevReview — Backend API  (review.js)               ║
 * ║  Single-file Express server — deploy on Railway / Render / VPS  ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  POST /api/review                                               ║
 * ║  Supported: python · javascript · cpp · java · c · go           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 *  Flow per request:
 *    1. Validate input
 *    2. Static analysis  (pylint+bandit / ESLint / cppcheck / javac / gcc / go vet)
 *    3. Sandbox execution (subprocess timeout / Node VM / compile+run)
 *    4. Qwen LLM review  → structured JSON including rewritten_code
 *    5. Return combined JSON response
 *
 *  ── SETUP ──────────────────────────────────────────────────────────
 *  npm init -y
 *  npm install express cors node-fetch
 *
 *  System tools (install on your server — NOT available on Vercel):
 *    Python : pip install pylint bandit
 *    JS     : npx ships with Node — no extra install
 *    C++    : apt install cppcheck g++
 *    Java   : apt install default-jdk
 *    C      : apt install gcc
 *    Go     : apt install golang-go
 *
 *  ── ENV VARS ───────────────────────────────────────────────────────
 *  QWEN_API_KEY    = sk-...          (required)
 *  FRONTEND_ORIGIN = https://devrewiewom-smsz.vercel.app  (required for CORS)
 *  PORT            = 3000            (optional, default 3000)
 *
 *  ── RUN ────────────────────────────────────────────────────────────
 *  node review.js
 *
 *  ── FRONTEND WIRING ────────────────────────────────────────────────
 *  In your Vercel frontend JS, change the fetch target to:
 *    const API_BASE = "https://your-backend.up.railway.app"
 *    fetch(`${API_BASE}/api/review`, { method: "POST", ... })
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
import { exec }       from "child_process";
import fetch          from "node-fetch";

const execAsync = promisify(exec);

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3000;
const QWEN_API_KEY    = process.env.QWEN_API_KEY;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "https://devrewiewom-smsz.vercel.app";
const QWEN_API_URL    = "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const QWEN_MODEL      = "qwen-plus";
const EXEC_TIMEOUT    = 6000;    // ms — sandbox execution hard limit
const MAX_CODE_LEN    = 20000;   // characters

const SUPPORTED_LANGS = ["python", "javascript", "cpp", "java", "c", "go"];

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

// ════════════════════════════════════════════════════════════════════
// FIX 1 — CORS
// Allow your Vercel frontend to call this backend across origins.
// Without this every browser request is silently blocked.
// ════════════════════════════════════════════════════════════════════
app.use(cors({
  origin:         FRONTEND_ORIGIN,
  methods:        ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json({ limit: "1mb" }));

// ─── Utility helpers ──────────────────────────────────────────────────────────

/** Write code to a uniquely-named temp file and return its path */
function tmpFile(code, ext) {
  const name = `devreview_${crypto.randomBytes(8).toString("hex")}`;
  const fp   = path.join(os.tmpdir(), `${name}.${ext}`);
  fs.writeFileSync(fp, code, "utf8");
  return fp;
}

/** Delete files without ever throwing */
function rm(...paths) {
  for (const p of paths) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
  }
}

/**
 * Run a shell command with a hard timeout.
 * Always resolves — errors are captured in { stdout, stderr }.
 */
async function shell(cmd, timeoutMs = EXEC_TIMEOUT) {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout:   timeoutMs,
      maxBuffer: 512 * 1024,
      shell:     true,
    });
    return { stdout: (stdout || "").trim(), stderr: (stderr || "").trim() };
  } catch (err) {
    return {
      stdout: (err.stdout || "").trim(),
      stderr: (err.stderr || err.message || "error").trim(),
    };
  }
}

// ════════════════════════════════════════════════════════════════════
// SECTION 1 — Static Analysis (one function per language)
// ════════════════════════════════════════════════════════════════════

/** Python: PyLint (code quality) + Bandit (security) */
async function staticPython(code) {
  const fp  = tmpFile(code, "py");
  const out = [];
  try {
    const lint = await shell(`pylint "${fp}" --output-format=text --score=no 2>&1`);
    if (lint.stdout) out.push(`[PyLint]\n${lint.stdout}`);

    const sec = await shell(`bandit -r "${fp}" -f txt -q 2>&1`);
    if (sec.stdout) out.push(`[Bandit]\n${sec.stdout}`);
  } finally { rm(fp); }
  return out;
}

/** JavaScript: ESLint with inline ruleset (no .eslintrc needed) */
async function staticJavaScript(code) {
  const fp    = tmpFile(code, "js");
  const out   = [];
  const rules = JSON.stringify({
    "no-undef":       2,
    "no-unused-vars": 1,
    "eqeqeq":         1,
    "no-eval":        2,
    "no-implied-eval":2,
  });
  try {
    const res = await shell(
      `npx eslint "${fp}" --no-eslintrc --rule '${rules}' --format compact 2>&1`
    );
    if (res.stdout) out.push(`[ESLint]\n${res.stdout}`);
  } finally { rm(fp); }
  return out;
}

/** C++: cppcheck */
async function staticCpp(code) {
  const fp  = tmpFile(code, "cpp");
  const out = [];
  try {
    const res = await shell(
      `cppcheck --enable=all --suppress=missingIncludeSystem "${fp}" 2>&1`
    );
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    if (combined) out.push(`[cppcheck]\n${combined}`);
  } finally { rm(fp); }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// FIX 3 — Java, C, Go static analysis (these were missing entirely)
// ════════════════════════════════════════════════════════════════════

/** Java: javac compile-check (catches all syntax + type errors) */
async function staticJava(code) {
  const fp  = tmpFile(code, "java");
  const out = [];
  try {
    const compile = await shell(`javac "${fp}" 2>&1`);
    const combined = [compile.stdout, compile.stderr].filter(Boolean).join("\n").trim();
    if (combined) out.push(`[javac]\n${combined}`);
  } finally { rm(fp); }
  return out;
}

/** C: gcc with -Wall -Wextra warnings pass (-fsyntax-only = no binary created) */
async function staticC(code) {
  const fp  = tmpFile(code, "c");
  const out = [];
  try {
    const res = await shell(`gcc -fsyntax-only -Wall -Wextra "${fp}" 2>&1`);
    const combined = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    if (combined) out.push(`[gcc warnings]\n${combined}`);
  } finally { rm(fp); }
  return out;
}

/** Go: go vet in a throw-away module directory */
async function staticGo(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "govet_"));
  const fp  = path.join(dir, "main.go");
  const out = [];
  try {
    fs.writeFileSync(fp, code, "utf8");
    await shell(`cd "${dir}" && go mod init devreview 2>&1`);
    const vet = await shell(`cd "${dir}" && go vet ./... 2>&1`);
    const combined = [vet.stdout, vet.stderr].filter(Boolean).join("\n").trim();
    if (combined) out.push(`[go vet]\n${combined}`);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
// SECTION 2 — Sandbox Execution (one function per language)
// ════════════════════════════════════════════════════════════════════

/**
 * JavaScript — Node.js vm module with a stripped sandbox context.
 * require / process / fs / child_process are NOT exposed.
 */
function sandboxJS(code) {
  const logs = [];
  const ctx  = vm.createContext({
    console: {
      log:   (...a) => logs.push(a.map(String).join(" ")),
      error: (...a) => logs.push("[err] " + a.map(String).join(" ")),
      warn:  (...a) => logs.push("[warn] " + a.map(String).join(" ")),
    },
    // Intentionally omit: require, process, Buffer, __dirname, fetch, XMLHttpRequest
  });
  try {
    new vm.Script(code, { timeout: EXEC_TIMEOUT }).runInContext(ctx, { timeout: EXEC_TIMEOUT });
    return { output: logs.join("\n"), error: null };
  } catch (e) {
    return { output: logs.join("\n"), error: e.message };
  }
}

/** Python — subprocess with hard timeout (swap for Docker for full isolation) */
async function sandboxPython(code) {
  const fp = tmpFile(code, "py");
  try {
    const r = await shell(`python3 "${fp}" 2>&1`, EXEC_TIMEOUT);
    return { output: r.stdout || "", error: r.stderr || null };
  } finally { rm(fp); }
}

/** C++ — compile to temp binary, execute, clean up both files */
async function sandboxCpp(code) {
  const src = tmpFile(code, "cpp");
  const bin = src.replace(".cpp", ".out");
  try {
    const compile = await shell(`g++ -o "${bin}" "${src}" -std=c++17 2>&1`);
    if (compile.stderr) return { output: "", error: `[Compile error]\n${compile.stderr}` };
    const run = await shell(`"${bin}" 2>&1`, EXEC_TIMEOUT);
    return { output: run.stdout || "", error: run.stderr || null };
  } finally { rm(src, bin); }
}

/** Java — detect public class name, compile, run in temp dir */
async function sandboxJava(code) {
  const match     = code.match(/public\s+class\s+(\w+)/);
  const className = match ? match[1] : "Main";
  const dir       = fs.mkdtempSync(path.join(os.tmpdir(), "jrun_"));
  const src       = path.join(dir, `${className}.java`);
  try {
    fs.writeFileSync(src, code, "utf8");
    const compile = await shell(`javac "${src}" 2>&1`);
    if (compile.stderr && compile.stderr.includes("error:")) {
      return { output: "", error: `[javac]\n${compile.stderr}` };
    }
    const run = await shell(`java -cp "${dir}" ${className} 2>&1`, EXEC_TIMEOUT);
    return { output: run.stdout || "", error: run.stderr || null };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/** C — compile with gcc, execute binary */
async function sandboxC(code) {
  const src = tmpFile(code, "c");
  const bin = src.replace(".c", ".out");
  try {
    const compile = await shell(`gcc -o "${bin}" "${src}" -lm 2>&1`);
    if (compile.stderr && compile.stderr.includes("error:")) {
      return { output: "", error: `[gcc]\n${compile.stderr}` };
    }
    const run = await shell(`"${bin}" 2>&1`, EXEC_TIMEOUT);
    return { output: run.stdout || "", error: run.stderr || null };
  } finally { rm(src, bin); }
}

/** Go — go run in a temp module dir */
async function sandboxGo(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gorun_"));
  const fp  = path.join(dir, "main.go");
  try {
    fs.writeFileSync(fp, code, "utf8");
    await shell(`cd "${dir}" && go mod init devreview 2>&1`);
    const run = await shell(`cd "${dir}" && go run main.go 2>&1`, EXEC_TIMEOUT);
    // go run puts compile errors in stderr; runtime errors go to stdout
    return {
      output: run.stdout || "",
      error:  run.stderr ? run.stderr : null,
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

// ─── Language router helpers ──────────────────────────────────────────────────

async function runStatic(lang, code) {
  switch (lang) {
    case "python":     return staticPython(code);
    case "javascript": return staticJavaScript(code);
    case "cpp":        return staticCpp(code);
    case "java":       return staticJava(code);       // FIX 3
    case "c":          return staticC(code);           // FIX 3
    case "go":         return staticGo(code);          // FIX 3
    default:           return [];
  }
}

async function runSandbox(lang, code) {
  switch (lang) {
    case "python":     return sandboxPython(code);
    case "javascript": return sandboxJS(code);
    case "cpp":        return sandboxCpp(code);
    case "java":       return sandboxJava(code);      // FIX 3
    case "c":          return sandboxC(code);          // FIX 3
    case "go":         return sandboxGo(code);         // FIX 3
    default:           return { output: "", error: null };
  }
}

// ════════════════════════════════════════════════════════════════════
// SECTION 3 — Qwen LLM Review
// FIX 2 — Prompt now requests "rewritten_code" as a 5th field so
//          the "🔁 Rewritten Code" panel in your frontend populates.
// ════════════════════════════════════════════════════════════════════

async function callQwen({ code, language, staticIssues, runtimeError, runtimeOutput }) {
  if (!QWEN_API_KEY) throw new Error("QWEN_API_KEY env var is not set.");

  const staticSection  = staticIssues.length
    ? staticIssues.join("\n\n")
    : "No static analysis issues detected.";

  const runtimeSection = runtimeError
    ? `Runtime error:\n${runtimeError}`
    : runtimeOutput
    ? `Runtime output (no errors):\n${runtimeOutput}`
    : "Code produced no output.";

  // System prompt forces raw JSON with exactly 5 keys — including rewritten_code
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

  const resp = await fetch(QWEN_API_URL, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${QWEN_API_KEY}`,
    },
    body: JSON.stringify({
      model:       QWEN_MODEL,
      messages:    [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt   },
      ],
      temperature: 0.2,   // low = deterministic structured output
      max_tokens:  3072,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Qwen API ${resp.status}: ${body}`);
  }

  const data = await resp.json();
  const raw  = (data?.choices?.[0]?.message?.content || "").trim();

  // Strip ```json ... ``` fences if Qwen adds them despite instructions
  const clean = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    // Graceful fallback — never let a parse error crash the whole request
    return {
      bugs:                   [`[Qwen parse error] Raw: ${raw.slice(0, 400)}`],
      security_issues:        [],
      performance_tips:       [],
      clean_code_suggestions: [],
      rewritten_code:         "// Could not generate rewritten code — see bugs for details.",
    };
  }
}

// ════════════════════════════════════════════════════════════════════
// SECTION 4 — POST /api/review
// ════════════════════════════════════════════════════════════════════

app.post("/api/review", async (req, res) => {
  const { code, language } = req.body;

  // ── Input validation ─────────────────────────────────────────────
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
    return res.status(400).json({ error: `Code exceeds ${MAX_CODE_LEN} character limit.` });
  }

  try {
    // ── Step 1: Static analysis ──────────────────────────────────────
    console.log(`[review] static   → ${lang}`);
    const staticIssues = await runStatic(lang, code);

    // ── Step 2: Sandbox execution ────────────────────────────────────
    console.log(`[review] sandbox  → ${lang}`);
    const runtime = await runSandbox(lang, code);

    // ── Step 3: Qwen AI review ───────────────────────────────────────
    console.log(`[review] qwen     → ${lang}`);
    const ai = await callQwen({
      code,
      language:      lang,
      staticIssues,
      runtimeError:  runtime.error,
      runtimeOutput: runtime.output,
    });

    // ── Step 4: Build summary counts (FIX 4 — badge counts for UI) ──
    const summary = {
      bugs:     (ai.bugs                    || []).length,
      security: (ai.security_issues         || []).length,
      perf:     (ai.performance_tips         || []).length,
      clean:    (ai.clean_code_suggestions   || []).length,
    };

    // ── Step 5: Return combined response ─────────────────────────────
    return res.status(200).json({
      language,
      summary,                        // { bugs, security, perf, clean } — drives badge counts
      static_issues: staticIssues,    // raw tool output strings
      runtime: {
        output: runtime.output || null,
        error:  runtime.error  || null,
      },
      ai_review: {
        bugs:                   ai.bugs                    || [],
        security_issues:        ai.security_issues         || [],
        performance_tips:       ai.performance_tips         || [],
        clean_code_suggestions: ai.clean_code_suggestions   || [],
        rewritten_code:         ai.rewritten_code           || "",  // FIX 2 — powers 🔁 panel
      },
    });

  } catch (err) {
    console.error("[review] unhandled error:", err.message);
    return res.status(500).json({ error: "Internal server error.", details: err.message });
  }
});

// ─── Health check endpoint ────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "2.0.0", languages: SUPPORTED_LANGS });
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════╗`);
  console.log(`  ║   DevReview API  v2.0  — ready        ║`);
  console.log(`  ╚═══════════════════════════════════════╝`);
  console.log(`  URL     : http://localhost:${PORT}`);
  console.log(`  CORS    : ${FRONTEND_ORIGIN}`);
  console.log(`  Model   : ${QWEN_MODEL}`);
  console.log(`  Langs   : ${SUPPORTED_LANGS.join(" · ")}\n`);
});

/*
 * ══════════════════════════════════════════════════════════════════
 *  package.json  (create this alongside review.js)
 * ══════════════════════════════════════════════════════════════════
 *  {
 *    "name": "devreview-api",
 *    "version": "2.0.0",
 *    "type": "module",
 *    "main": "review.js",
 *    "scripts": { "start": "node review.js" },
 *    "dependencies": {
 *      "express":    "^4.18.2",
 *      "cors":       "^2.8.5",
 *      "node-fetch": "^3.3.2"
 *    }
 *  }
 *
 * ══════════════════════════════════════════════════════════════════
 *  EXAMPLE REQUESTS
 * ══════════════════════════════════════════════════════════════════
 *
 *  Python:
 *  curl -X POST http://localhost:3000/api/review \
 *    -H "Content-Type: application/json" \
 *    -d '{"code":"import os\neval(input())\nx=1/0","language":"python"}'
 *
 *  JavaScript:
 *  curl -X POST http://localhost:3000/api/review \
 *    -H "Content-Type: application/json" \
 *    -d '{"code":"var x=1;if(x==\"1\")console.log(\"loose eq\");","language":"javascript"}'
 *
 *  Java:
 *  curl -X POST http://localhost:3000/api/review \
 *    -H "Content-Type: application/json" \
 *    -d '{"code":"public class Main{public static void main(String[] a){System.out.println(1/0);}}","language":"java"}'
 *
 *  Go:
 *  curl -X POST http://localhost:3000/api/review \
 *    -H "Content-Type: application/json" \
 *    -d '{"code":"package main\nimport \"fmt\"\nfunc main(){fmt.Println(\"hello\")}","language":"go"}'
 *
 * ══════════════════════════════════════════════════════════════════
 *  RESPONSE SHAPE
 * ══════════════════════════════════════════════════════════════════
 *  {
 *    "language": "python",
 *    "summary":  { "bugs": 2, "security": 1, "perf": 0, "clean": 3 },
 *    "static_issues": ["[PyLint]\n...", "[Bandit]\n..."],
 *    "runtime":  { "output": "", "error": "ZeroDivisionError: ..." },
 *    "ai_review": {
 *      "bugs":                   ["Division by zero on line 3"],
 *      "security_issues":        ["eval() allows arbitrary code injection"],
 *      "performance_tips":       [],
 *      "clean_code_suggestions": ["Use snake_case for variable names"],
 *      "rewritten_code":         "# Improved version\nimport sys\n..."
 *    }
 *  }
 *
 * ══════════════════════════════════════════════════════════════════
 *  DEPLOYING ON RAILWAY (recommended)
 * ══════════════════════════════════════════════════════════════════
 *  1. Push review.js + package.json to a new GitHub repo
 *  2. railway.app → New Project → Deploy from GitHub repo
 *  3. Add environment variables in Railway dashboard:
 *       QWEN_API_KEY    = sk-your-dashscope-key
 *       FRONTEND_ORIGIN = https://devrewiewom-smsz.vercel.app
 *  4. Railway auto-detects Node and runs: node review.js
 *  5. In Railway → Settings → Networking → expose a public domain
 *  6. Copy that domain and update your Vercel frontend:
 *       const API_BASE = "https://your-project.up.railway.app"
 *       fetch(`${API_BASE}/api/review`, { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({code, language}) })
 *
 *  NOTE: Railway's free Hobby plan includes system apt packages.
 *  Add a nixpacks.toml to install system tools automatically:
 *  ── nixpacks.toml ──────────────────────────────────────────────
 *  [phases.setup]
 *  nixPkgs = ["python3", "python3Packages.pylint", "bandit",
 *             "cppcheck", "gcc", "jdk", "go"]
 * ══════════════════════════════════════════════════════════════════
 */
