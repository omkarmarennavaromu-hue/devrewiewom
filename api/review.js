// /api/review.js
// Serverless API endpoint for code review using OpenRouter

export default async function handler(req, res) {
  // 1. Enforce POST method
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // 2. Validate required fields
  const { language, code } = req.body;

  if (!language || typeof language !== 'string' || language.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid "language" field.' });
  }

  if (!code || typeof code !== 'string' || code.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid "code" field.' });
  }

  // 3. Check API key
  const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) {
    console.error('OpenRouter API key is not configured.');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // 4. Prepare the ultra-strict prompt
  const prompt = `You are an expert code reviewer. Analyze the following ${language} code and return a JSON object with EXACTLY these keys: "bugs", "security", "performance", "suggestions", "rewrite".

STRICT RULES:
- Output ONLY valid JSON. No markdown, no backticks, no explanations, no additional text before or after.
- All values must be arrays of strings, except "rewrite" which must be a string.
- If a category has no findings, return an empty array [].
- "rewrite" must contain the corrected/improved version of the code. If no changes are needed, return the original code unchanged.
- Do not include any comments or descriptions outside the JSON structure.

CODE TO REVIEW (${language}):
\`\`\`
${code}
\`\`\`

Your response must be a single JSON object like this example:
{
  "bugs": ["Syntax error on line 5: missing semicolon"],
  "security": ["Potential SQL injection on line 12"],
  "performance": ["Unnecessary loop nesting increases complexity"],
  "suggestions": ["Use const instead of let for immutable variables"],
  "rewrite": "// corrected code here"
}`;

  // 5. Call OpenRouter API
  let aiResponse;
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'qwen/qwen-2.5-72b-instruct',
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2, // Low temperature for consistent JSON output
        max_tokens: 2000,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`OpenRouter API error (${response.status}):`, errorText);
      return res.status(500).json({
        error: 'Failed to get review from AI.',
        details: `Status: ${response.status}`,
      });
    }

    const data = await response.json();
    aiResponse = data.choices?.[0]?.message?.content;

    if (!aiResponse) {
      console.error('Empty response from OpenRouter:', data);
      return res.status(500).json({
        error: 'AI returned an empty response.',
      });
    }
  } catch (error) {
    console.error('Network or fetch error:', error);
    return res.status(500).json({
      error: 'Unable to reach AI service.',
      details: error.message,
    });
  }

  // 6. Parse AI response – remove markdown fences if present
  let cleanedResponse = aiResponse.trim();

  // Remove ```json ... ``` or ``` ... ``` blocks
  const jsonFenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const match = cleanedResponse.match(jsonFenceRegex);
  if (match) {
    cleanedResponse = match[1].trim();
  }

  // Try to extract JSON if there's still extra text
  const jsonStart = cleanedResponse.indexOf('{');
  const jsonEnd = cleanedResponse.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
    cleanedResponse = cleanedResponse.substring(jsonStart, jsonEnd + 1);
  }

  // 7. Parse and validate JSON structure
  let parsed;
  try {
    parsed = JSON.parse(cleanedResponse);
  } catch (err) {
    console.error('Failed to parse AI JSON:', cleanedResponse);
    return res.status(500).json({
      error: 'AI returned malformed JSON.',
      rawPreview: aiResponse.substring(0, 300), // truncated for debugging
    });
  }

  // 8. Validate required keys
  const requiredKeys = ['bugs', 'security', 'performance', 'suggestions', 'rewrite'];
  const missingKeys = requiredKeys.filter(key => !parsed.hasOwnProperty(key));

  if (missingKeys.length > 0) {
    console.error('Missing keys in AI response:', missingKeys, parsed);
    return res.status(500).json({
      error: 'AI response missing required fields.',
      missingKeys,
      rawPreview: aiResponse.substring(0, 300),
    });
  }

  // Ensure arrays and string types
  const validated = {
    bugs: Array.isArray(parsed.bugs) ? parsed.bugs.map(String) : [],
    security: Array.isArray(parsed.security) ? parsed.security.map(String) : [],
    performance: Array.isArray(parsed.performance) ? parsed.performance.map(String) : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : [],
    rewrite: typeof parsed.rewrite === 'string' ? parsed.rewrite : String(parsed.rewrite || ''),
  };

  // 9. Return successful response
  return res.status(200).json(validated);
}
