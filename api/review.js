// /api/review.js

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const { language, code } = req.body;

    // Validate required fields
    if (!language || !code) {
      return res.status(400).json({ 
        error: 'Missing required fields. Please provide both "language" and "code".' 
      });
    }

    // Validate API key exists
    if (!process.env.OPENROUTER_API_KEY) {
      console.error('OPENROUTER_API_KEY is not set in environment variables');
      return res.status(500).json({ error: 'Server configuration error' });
    }

    // Construct the prompt for the AI
    const prompt = `You are an expert code reviewer. Analyze the following ${language} code and provide a strict JSON response with exactly these keys: "bugs", "security", "performance", "suggestions", "rewrite".

Rules:
- "bugs": List any syntax errors, runtime errors, or logical flaws. Return an array of strings. If none, return an empty array.
- "security": Identify potential security vulnerabilities (e.g., injection, XSS, auth issues). Return an array of strings. If none, return an empty array.
- "performance": Suggest performance improvements. Return an array of strings. If none, return an empty array.
- "suggestions": General code quality, readability, or best practice recommendations. Return an array of strings. If none, return an empty array.
- "rewrite": Provide a single improved version of the code as a string. If no rewrite needed, return the original code.

IMPORTANT: Respond with VALID JSON ONLY. No markdown, no code fences, no explanations outside the JSON structure.

Code to review:
\`\`\`${language}
${code}
\`\`\``;

    // Call OpenRouter API
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000',
        'X-Title': 'Code Reviewer API'
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct:free',
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ],
        response_format: { type: 'json_object' } // Ensures JSON response if model supports it
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('OpenRouter API error:', response.status, errorData);
      return res.status(502).json({ 
        error: 'Failed to get analysis from AI service',
        details: errorData.error?.message || 'Unknown error'
      });
    }

    const data = await response.json();
    let aiResponse = data.choices?.[0]?.message?.content;

    // Parse and validate the JSON response
    try {
      // Clean potential markdown code fences if present
      aiResponse = aiResponse.replace(/^```json\s*|\s*```$/g, '').trim();
      const parsed = JSON.parse(aiResponse);
      
      // Validate required keys exist
      const requiredKeys = ['bugs', 'security', 'performance', 'suggestions', 'rewrite'];
      for (const key of requiredKeys) {
        if (!(key in parsed)) {
          throw new Error(`Missing required key: ${key}`);
        }
      }
      
      return res.status(200).json(parsed);
    } catch (parseError) {
      console.error('Failed to parse AI response as JSON:', parseError);
      console.error('Raw response:', aiResponse);
      return res.status(500).json({ 
        error: 'Invalid response format from AI service',
        raw: aiResponse?.substring(0, 200) + '...' // Truncate for safety
      });
    }

  } catch (error) {
    console.error('Unhandled error in review API:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
