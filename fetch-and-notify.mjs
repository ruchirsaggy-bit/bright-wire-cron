// Bright Wire — daily fetch + 7am notification
//
// Runs every hour via GitHub Actions (see .github/workflows/daily-brightwire.yml).
// Each run checks the current time in America/Toronto; it only does real work
// during the 7am hour. This makes daylight saving handle itself — no manual
// UTC-offset math, no missed or double-fired mornings in spring/fall.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC; // e.g. "ruchir-bright-wire-8f2k" — pick anything unguessable
const TIMEZONE = process.env.BRIGHT_WIRE_TIMEZONE || "America/Toronto";
const TARGET_HOUR = Number(process.env.BRIGHT_WIRE_HOUR || 7); // 24h, local to TIMEZONE

const DISPATCH_SYSTEM_PROMPT = `You are a careful news curator for a small daily app called "Bright Wire" that shows one dispatch at a time about genuine, current, real-world BENEFITS of AI — not AI industry/business news (funding, pricing, model launches, politics) unless it directly and concretely helps people.

Use web search to find real stories from roughly the last 7 days about AI producing a concrete positive outcome: health and medicine, scientific research, accessibility, environment/climate, education, safety, disaster response, and similar. Prefer credible outlets and primary sources. Order the array with the single most significant, well-sourced story first — that one will be used as the day's push notification headline, so it should be the strongest, most concrete, least hype-y pick of the six.

Return ONLY a raw JSON array (no markdown code fences, no commentary before or after) of exactly 6 objects, each shaped exactly like this:
{
  "category": "SHORT UPPERCASE LABEL",
  "headline": "Specific, concrete headline under 100 characters, written in your own words",
  "dek": "One sentence of extra context, your own words",
  "paragraphs": ["2-3 sentence paragraph in your own words, never copied verbatim from any source", "A second paragraph in your own words"],
  "whyItMatters": "One sentence on why this matters, your own words, hedge appropriately if the claim is a single company's unverified announcement",
  "source": { "name": "Publication or outlet name", "url": "A real URL that actually appeared in your search results" }
}

Rules: paraphrase everything, never quote a source directly, use only URLs you actually found via search, cover 6 different topics/categories, and output nothing but the JSON array.`;

function currentLocalHour(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const hourPart = parts.find((p) => p.type === "hour").value;
  return Number(hourPart) % 24;
}

function todayKey(timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date()); // en-CA => YYYY-MM-DD
}

function extractJsonArray(text) {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/, "")
    .replace(/```\s*$/, "");
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("No JSON array found in model response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

async function fetchTodaysStories() {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      system: DISPATCH_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            "Find today's edition: 6 fresh, verifiable, benefit-focused AI news stories from the last week, strongest and most concrete first. Output the JSON array only.",
        },
      ],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Anthropic API returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const data = await response.json();
  const textBlocks = (data.content || []).filter((b) => b.type === "text").map((b) => b.text);
  if (textBlocks.length === 0) throw new Error("No text content in Anthropic API response");
  const finalText = textBlocks[textBlocks.length - 1];
  const stories = extractJsonArray(finalText);
  if (!Array.isArray(stories) || stories.length === 0) throw new Error("Parsed empty story list");
  return stories;
}

async function sendNotification(lead) {
  if (!NTFY_TOPIC) {
    console.log("NTFY_TOPIC not set — skipping push notification, stories were still fetched and saved.");
    return;
  }
  const title = `Bright Wire — ${lead.category}`;
  const body = `${lead.headline}\n\n${lead.dek}`;

  const res = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: {
      Title: title,
      Priority: "default",
      Tags: "bulb",
      ...(lead.source && lead.source.url ? { Click: lead.source.url } : {}),
    },
    body,
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`ntfy.sh push failed: ${res.status} ${errBody.slice(0, 300)}`);
  }
  console.log("Notification sent to ntfy.sh topic:", NTFY_TOPIC);
}

async function main() {
  const hour = currentLocalHour(TIMEZONE);
  const force = process.env.BRIGHT_WIRE_FORCE_RUN === "true"; // for manual workflow_dispatch testing

  if (hour !== TARGET_HOUR && !force) {
    console.log(
      `Current local hour in ${TIMEZONE} is ${hour}, target is ${TARGET_HOUR}. Nothing to do this run.`
    );
    return;
  }

  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it as a GitHub Actions secret.");
  }

  console.log(`Local hour matches target (${TARGET_HOUR}:00 ${TIMEZONE}). Fetching today's edition...`);
  const stories = await fetchTodaysStories();
  const lead = stories[0];

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  const key = todayKey(TIMEZONE);
  const payload = { date: key, fetchedAt: new Date().toISOString(), stories };
  await fs.writeFile(`data/${key}.json`, JSON.stringify(payload, null, 2));
  await fs.writeFile("data/latest.json", JSON.stringify(payload, null, 2));
  console.log(`Saved data/${key}.json and data/latest.json`);

  await sendNotification(lead);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Bright Wire run failed:", err);
  process.exit(1);
});
