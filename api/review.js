// review.js
// Complete backend API for code review with static analysis, sandboxed execution, and Qwen AI suggestions

const express = require('express');
const { exec, spawn } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { VM } = require('vm2');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' })); // Allow large code submissions

// Configuration
const PORT = process.env.PORT || 3001;
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const QWEN_API_URL = process.env.QWEN_API_URL || 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation';

// Validate Qwen API configuration
if (!QWEN_API_KEY) {
  console.error('WARNING: QWEN_API_KEY environment variable is not set. Qwen AI suggestions will use fallback responses.');
}

// ========== UTILITY FUNCTIONS ==========

/**
 * Create a temporary directory for safe code execution
 */
async function createTempDir() {
  const tempDir = path.join(os.tmpdir(), `code-review-${crypto.randomBytes(16).toString('hex')}`);
  await fs.mkdir(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Cleanup temporary directory
 */
async function cleanupTempDir(tempDir) {
  try {
    await fs.rm(tempDir, { recursive: true, force: true });
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

/**
 * Execute command with timeout and resource limits
 */
async function executeCommand(command, args, options = {}) {
  const timeout = options.timeout || 5000;
  
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, {
      ...options,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      process.kill('SIGTERM');
      reject(new Error(`Command timed out after ${timeout}ms`));
    }, timeout);

    process.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      clearTimeout(timer);
      if (!timedOut) {
        resolve({ stdout, stderr, code });
      }
    });

    process.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// ========== STATIC ANALYSIS ==========

/**
 * Run static analysis tools based on programming language
 */
async function runStaticAnalysis(code, language) {
  const tempDir = await createTempDir();
  const results = [];

  try {
    switch (language.toLowerCase()) {
      case 'python':
        // Save code to temp file
        const pythonFile = path.join(tempDir, 'code.py');
        await fs.writeFile(pythonFile, code);

        // Run PyLint
        try {
          const pylintResult = await executeCommand('pylint', [pythonFile, '--output-format=json', '--msg-template="{line}:{column}: {msg_id} {msg}"'], { timeout: 10000 });
          if (pylintResult.stdout && pylintResult.stdout.trim()) {
            const pylintErrors = JSON.parse(pylintResult.stdout);
            results.push(...pylintErrors.map(err => ({
              line: err.line || 0,
              column: err.column || 0,
              message: err.message || err.msg || 'Unknown error',
              severity: err.type || (err.severity === 'error' ? 'error' : 'warning'),
              tool: 'pylint',
              ruleId: err.symbol || err.msg_id
            })));
          }
        } catch (error) {
          if (!error.message.includes('timed out')) {
            results.push({ 
              message: `PyLint error: ${error.message}`, 
              severity: 'info', 
              tool: 'pylint' 
            });
          }
        }

        // Run Bandit for security scanning
        try {
          const banditResult = await executeCommand('bandit', ['-f', 'json', '-o', '-', pythonFile], { timeout: 10000 });
          if (banditResult.stdout && banditResult.stdout.trim()) {
            const banditOutput = JSON.parse(banditResult.stdout);
            if (banditOutput.results && banditOutput.results.length) {
              results.push(...banditOutput.results.map(issue => ({
                line: issue.line_range?.[0] || 0,
                message: issue.issue_text,
                severity: issue.severity,
                tool: 'bandit',
                ruleId: issue.test_id
              })));
            }
          }
        } catch (error) {
          if (!error.message.includes('timed out')) {
            results.push({ 
              message: `Bandit error: ${error.message}`, 
              severity: 'info', 
              tool: 'bandit' 
            });
          }
        }
        break;

      case 'javascript':
        const jsFile = path.join(tempDir, 'code.js');
        await fs.writeFile(jsFile, code);

        // Create ESLint configuration
        const eslintConfig = {
          extends: ['eslint:recommended'],
          env: { node: true, es6: true, browser: true },
          parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
          rules: {
            'no-unused-vars': 'warn',
            'no-console': 'warn'
          }
        };
        await fs.writeFile(path.join(tempDir, '.eslintrc.json'), JSON.stringify(eslintConfig));

        try {
          const eslintResult = await executeCommand('npx', ['eslint', jsFile, '--format=json'], { timeout: 10000 });
          if (eslintResult.stdout && eslintResult.stdout.trim()) {
            const eslintOutput = JSON.parse(eslintResult.stdout);
            if (eslintOutput[0]?.messages && eslintOutput[0].messages.length) {
              results.push(...eslintOutput[0].messages.map(msg => ({
                line: msg.line || 0,
                column: msg.column || 0,
                message: msg.message,
                severity: msg.severity === 1 ? 'warning' : 'error',
                ruleId: msg.ruleId,
                tool: 'eslint'
              })));
            }
          }
        } catch (error) {
          if (!error.message.includes('timed out')) {
            results.push({ 
              message: `ESLint error: ${error.message}`, 
              severity: 'info', 
              tool: 'eslint' 
            });
          }
        }
        break;

      case 'cpp':
      case 'c++':
        const cppFile = path.join(tempDir, 'code.cpp');
        await fs.writeFile(cppFile, code);

        // Run cppcheck with various checks
        try {
          const cppcheckResult = await executeCommand('cppcheck', [cppFile, '--enable=all', '--error-exitcode=0', '--xml-version=2'], { timeout: 10000 });
          
          // Parse stderr output (cppcheck outputs to stderr)
          if (cppcheckResult.stderr) {
            const lines = cppcheckResult.stderr.split('\n');
            for (const line of lines) {
              // Match patterns like: [file.cpp:line]: (severity) message
              const match = line.match(/\[.*?:(\d+)\]:\s*\((\w+)\)\s*(.+)/);
              if (match) {
                results.push({
                  line: parseInt(match[1]) || 0,
                  message: match[3],
                  severity: match[2],
                  tool: 'cppcheck'
                });
              } else if (line.includes('error:') || line.includes('warning:')) {
                results.push({
                  message: line.trim(),
                  severity: line.includes('error:') ? 'error' : 'warning',
                  tool: 'cppcheck'
                });
              }
            }
          }
        } catch (error) {
          if (!error.message.includes('timed out')) {
            results.push({ 
              message: `Cppcheck error: ${error.message}`, 
              severity: 'info', 
              tool: 'cppcheck' 
            });
          }
        }
        break;

      default:
        results.push({ 
          message: `Static analysis not available for ${language}`, 
          severity: 'info', 
          tool: 'static-analyzer' 
        });
    }
  } finally {
    await cleanupTempDir(tempDir);
  }

  return results;
}

// ========== SANDBOXED EXECUTION ==========

/**
 * Safely execute code in a sandboxed environment
 */
async function runSandboxed(code, language) {
  const runtimeErrors = [];

  try {
    switch (language.toLowerCase()) {
      case 'javascript':
        // Use VM2 for isolated JavaScript execution
        const vm = new VM({
          timeout: 2000, // 2 second timeout
          sandbox: {
            console: {
              log: (...args) => { /* Suppress console output */ },
              error: (...args) => { /* Suppress console output */ }
            }
          },
          eval: false,
          wasm: false
        });

        try {
          // Wrap code in a try-catch to capture runtime errors
          const wrappedCode = `
            try {
              ${code}
            } catch (error) {
              throw error;
            }
          `;
          vm.run(wrappedCode);
        } catch (error) {
          runtimeErrors.push({
            type: error.name || 'RuntimeError',
            message: error.message,
            stack: error.stack ? error.stack.split('\n').slice(0, 3).join('\n') : undefined
          });
        }
        break;

      case 'python':
        const pyTempDir = await createTempDir();
        const pythonFile = path.join(pyTempDir, 'script.py');
        
        // Add safety wrapper to prevent dangerous operations
        const safeCode = `
import sys
import builtins

# Disable dangerous functions
dangerous_funcs = ['__import__', 'eval', 'exec', 'compile', 'open', 'input']
for func in dangerous_funcs:
    if hasattr(builtins, func):
        delattr(builtins, func)

# Execute user code
try:
${code.split('\n').map(line => '    ' + line).join('\n')}
except Exception as e:
    print(f"ERROR: {type(e).__name__}: {e}", file=sys.stderr)
    sys.exit(1)
`;
        
        await fs.writeFile(pythonFile, safeCode);

        try {
          const result = await executeCommand('python3', [pythonFile], { timeout: 5000 });
          if (result.stderr && result.stderr.trim()) {
            runtimeErrors.push({
              type: 'PythonRuntimeError',
              message: result.stderr.trim(),
              code: result.code
            });
          }
        } catch (error) {
          runtimeErrors.push({
            type: 'ExecutionError',
            message: error.message
          });
        } finally {
          await cleanupTempDir(pyTempDir);
        }
        break;

      case 'cpp':
      case 'c++':
        const cppTempDir = await createTempDir();
        const cppFile = path.join(cppTempDir, 'code.cpp');
        const binaryFile = path.join(cppTempDir, 'program');
        
        // Add safety constraints to C++ code
        const safeCppCode = `
#include <iostream>
#include <chrono>
#include <thread>

// Safety wrapper
int main() {
    try {
${code.split('\n').map(line => '        ' + line).join('\n')}
    } catch (const std::exception& e) {
        std::cerr << "Exception: " << e.what() << std::endl;
        return 1;
    }
    return 0;
}
`;
        
        await fs.writeFile(cppFile, safeCppCode);

        try {
          // Compile C++ code with security flags
          const compileResult = await executeCommand('g++', [
            cppFile, 
            '-o', binaryFile, 
            '-Wall', 
            '-Wextra', 
            '-Werror',
            '-O2',
            '-fstack-protector-strong'
          ], { timeout: 10000 });
          
          if (compileResult.stderr && compileResult.stderr.trim()) {
            runtimeErrors.push({
              type: 'CompilationError',
              message: compileResult.stderr.trim()
            });
          } else {
            // Execute binary with timeout
            const runResult = await executeCommand(binaryFile, [], { timeout: 3000 });
            if (runResult.stderr && runResult.stderr.trim()) {
              runtimeErrors.push({
                type: 'RuntimeError',
                message: runResult.stderr.trim(),
                code: runResult.code
              });
            }
          }
        } catch (error) {
          runtimeErrors.push({
            type: 'ExecutionError',
            message: error.message
          });
        } finally {
          await cleanupTempDir(cppTempDir);
        }
        break;

      default:
        runtimeErrors.push({ 
          message: `Runtime execution not supported for ${language}`, 
          type: 'UnsupportedLanguage' 
        });
    }
  } catch (error) {
    runtimeErrors.push({
      type: 'SandboxError',
      message: error.message
    });
  }

  return runtimeErrors;
}

// ========== QWEN AI INTEGRATION ==========

/**
 * Generate AI suggestions using Qwen API
 */
async function getQwenSuggestions(code, staticErrors, runtimeErrors, language) {
  // If no API key, return fallback suggestions
  if (!QWEN_API_KEY) {
    console.log('Qwen API key not configured, returning fallback suggestions');
    return {
      bugs: ["Enable Qwen API with QWEN_API_KEY environment variable for AI-powered analysis"],
      security_issues: ["AI analysis disabled - set QWEN_API_KEY to enable"],
      performance_tips: ["Configure Qwen API for detailed performance recommendations"],
      clean_code_suggestions: ["Set up Qwen API integration for comprehensive code quality insights"]
    };
  }

  // Prepare structured data for Qwen
  const staticErrorsSummary = staticErrors.slice(0, 20).map(e => 
    `${e.tool}: ${e.message}${e.line ? ` (line ${e.line})` : ''}`
  ).join('\n');
  
  const runtimeErrorsSummary = runtimeErrors.map(e => 
    `${e.type}: ${e.message}`
  ).join('\n');

  // Construct prompt for Qwen
  const prompt = `You are an expert code reviewer. Analyze the following ${language} code and provide detailed suggestions.

CODE:
\`\`\`${language}
${code.length > 3000 ? code.substring(0, 3000) + '... [truncated]' : code}
\`\`\`

STATIC ANALYSIS FINDINGS:
${staticErrorsSummary || 'No static analysis issues found'}

RUNTIME ERRORS:
${runtimeErrorsSummary || 'No runtime errors detected'}

Based on the code and the issues above, provide your analysis in the following JSON format. Each section should contain 3-5 specific, actionable recommendations:

{
  "bugs": ["List of potential bugs or logical errors with specific line references if possible"],
  "security_issues": ["List of security vulnerabilities with severity indicators"],
  "performance_tips": ["List of performance optimizations with expected impact"],
  "clean_code_suggestions": ["List of code quality improvements following best practices"]
}

Return ONLY the JSON object, no other text.`;

  try {
    const response = await axios.post(QWEN_API_URL, {
      model: "qwen-turbo",
      input: {
        messages: [
          {
            role: "system",
            content: "You are an expert code reviewer. Always respond with valid JSON only."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      },
      parameters: {
        result_format: "message",
        temperature: 0.3,
        max_tokens: 2000,
        top_p: 0.9
      }
    }, {
      headers: {
        'Authorization': `Bearer ${QWEN_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    // Parse Qwen response
    let llmContent = '';
    if (response.data.output && response.data.output.choices) {
      llmContent = response.data.output.choices[0].message.content;
    } else if (response.data.text) {
      llmContent = response.data.text;
    } else {
      throw new Error('Unexpected Qwen API response format');
    }

    // Extract JSON from response
    const jsonMatch = llmContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const suggestions = JSON.parse(jsonMatch[0]);
      // Validate structure
      return {
        bugs: suggestions.bugs || [],
        security_issues: suggestions.security_issues || [],
        performance_tips: suggestions.performance_tips || [],
        clean_code_suggestions: suggestions.clean_code_suggestions || []
      };
    } else {
      throw new Error('Qwen response did not contain valid JSON');
    }
  } catch (error) {
    console.error('Qwen API error:', error.response?.data || error.message);
    // Return fallback suggestions with error context
    return {
      bugs: [`Qwen API error: ${error.message}. Please check API configuration.`],
      security_issues: ["Unable to analyze security - API error occurred"],
      performance_tips: ["Unable to analyze performance - API error occurred"],
      clean_code_suggestions: ["Unable to analyze code quality - API error occurred"]
    };
  }
}

// ========== MAIN ENDPOINT ==========

/**
 * POST /api/review
 * Main endpoint for code review
 */
app.post('/api/review', async (req, res) => {
  const { code, language } = req.body;

  // Validate input
  if (!code || typeof code !== 'string') {
    return res.status(400).json({
      error: 'Invalid or missing "code" field. Code must be a non-empty string.'
    });
  }

  if (!language || typeof language !== 'string') {
    return res.status(400).json({
      error: 'Invalid or missing "language" field. Language must be a string.'
    });
  }

  const supportedLanguages = ['python', 'javascript', 'cpp', 'c++'];
  const normalizedLang = language.toLowerCase();
  
  if (!supportedLanguages.includes(normalizedLang)) {
    return res.status(400).json({
      error: `Unsupported language: ${language}. Supported: ${supportedLanguages.join(', ')}`
    });
  }

  // Limit code size to prevent abuse
  if (code.length > 50000) {
    return res.status(400).json({
      error: 'Code too large. Maximum size is 50,000 characters.'
    });
  }

  try {
    console.log(`[${new Date().toISOString()}] Processing code review for ${normalizedLang} (${code.length} chars)`);

    // Step 1: Run static analysis
    console.log('Running static analysis...');
    const staticErrors = await runStaticAnalysis(code, normalizedLang);

    // Step 2: Run sandboxed execution
    console.log('Running sandboxed execution...');
    const runtimeErrors = await runSandboxed(code, normalizedLang);

    // Step 3: Get Qwen AI suggestions
    console.log('Getting Qwen AI suggestions...');
    const qwenSuggestions = await getQwenSuggestions(code, staticErrors, runtimeErrors, normalizedLang);

    // Step 4: Return combined response
    const response = {
      static_errors: staticErrors,
      runtime_errors: runtimeErrors,
      llm_suggestions: qwenSuggestions
    };

    console.log(`Review completed successfully`);
    res.json(response);
  } catch (error) {
    console.error('Review error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : 'An error occurred during code review'
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    qwen_configured: !!QWEN_API_KEY
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Code Review API with Qwen Integration`);
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Qwen API: ${QWEN_API_KEY ? 'Configured ✓' : 'Not configured ✗'}`);
  console.log(`Supported languages: Python, JavaScript, C++`);
  console.log(`===============================
