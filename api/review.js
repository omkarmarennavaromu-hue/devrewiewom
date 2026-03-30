export default async function handler(req, res) {
  // Only POST requests allowed
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { language, code } = req.body;
  if (!language || !code) {
    return res.status(400).json({ error: "Missing language or code" });
  }

  // Strict JSON prompt for the AI
  const prompt = `You are a strict senior software engineer.
Review the following ${language} code.
Respond **ONLY** in valid JSON **with no extra text**.
JSON must have keys: bugs, security, performance, suggestions, rewrite.
Use double quotes for all strings.
Include any syntax or runtime errors in the "bugs" field.
Do not include explanations outside the JSON.

CODE:
${code}`;

  try {
    // Call OpenRouter API
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "qwen/qwen-2.5-72b-instruct",
        messages: [{ role: "user", content: prompt }]
      })
    });

    const data = await response.json();

    // Validate response
    if (!data.choices || !data.choices[0]?.message?.content) {
      return res.status(500).json({ error: "Invalid response from OpenRouter" });
    }

    // Safely extract JSON even if AI adds extra text
    let reviewJson;
    try {
      const content = data.choices[0].message.content.match(/\{[\s\S]*\}/);
      reviewJson = JSON.parse(content ? content[0] : '{}');
    } catch {
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    // Return structured JSON to frontend
    return res.status(200).json(reviewJson);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
