export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const { language, code } = req.body;
  if (!language || !code) {
    return res.status(400).json({ error: "Missing language or code" });
  }

  const prompt = `You are a strict senior software engineer.
Review the following ${language} code and respond ONLY in valid JSON with keys:
bugs, security, performance, suggestions, rewrite.
Be concise and technical.

CODE:
${code}`;

  try {
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

    if (!data.choices || !data.choices[0]?.message?.content) {
      return res.status(500).json({ error: "Invalid response from OpenRouter" });
    }

    // Parse the AI response as JSON
    let reviewJson;
    try {
      reviewJson = JSON.parse(data.choices[0].message.content);
    } catch {
      return res.status(500).json({ error: "AI returned invalid JSON" });
    }

    return res.status(200).json(reviewJson);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
