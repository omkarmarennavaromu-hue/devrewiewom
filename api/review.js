import OpenAI from "openai";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "POST only" });
    }

    const { language, code } = req.body;

    if (!language || !code) {
      return res.status(400).json({ error: "Missing data" });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });

    const prompt = `Review this ${language} code and suggest bugs, improvements, and a better version:\n${code}`;

    const completion = await client.chat.completions.create({
      model: "qwen/qwen-2.5-72b-instruct",
      messages: [{ role: "user", content: prompt }],
    });

    const review = completion.choices[0].message.content;

    return res.status(200).json({ review });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
