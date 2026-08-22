// Bright Wire — daily fetch + 7am notification
//
// Runs every hour via GitHub Actions (see .github/workflows/daily-brightwire.yml).
// Each run checks the current time in America/Toronto; it only does real work
// during the 7am hour. This makes daylight saving handle itself — no manual
// UTC-offset math, no missed or double-fired mornings in spring/fall.

import { Agent, setGlobalDispatcher } from "undici";

// Node's default fetch times out waiting for response headers after 5
// minutes. A search-heavy request (multiple web_search rounds before
// Claude produces the final answer) can occasionally run longer than
// that, so raise the ceiling rather than fail a run over a slow-but-
// otherwise-healthy response.
setGlobalDispatcher(new Agent({ headersTimeout: 600_000, bodyTimeout: 600_000 }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const NTFY_TOPIC = process.env.NTFY_TOPIC; // e.g. "ruchir-bright-wire-8f2k" — pick anything unguessable
const TIMEZONE = process.env.BRIGHT_WIRE_TIMEZONE || "America/Toronto";
const TARGET_HOUR = Number(process.env.BRIGHT_WIRE_HOUR || 7); // 24h, local to TIMEZONE

const ALL_CATEGORIES = [
  "MEDICINE",
  "SCIENCE & RESEARCH",
  "ENVIRONMENT & CLIMATE",
  "ACCESSIBILITY",
  "EDUCATION",
  "SAFETY & DISASTER RESPONSE",
];

// Set by the app via the BRIGHT_WIRE_CATEGORIES repo variable when the
// person picks categories in Bright Wire. Comma-separated, must match
// ALL_CATEGORIES values exactly. Empty/unset = no restriction, all six.
const rawSelection = (process.env.BRIGHT_WIRE_CATEGORIES || "")
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const ACTIVE_CATEGORIES =
  rawSelection.length > 0 ? ALL_CATEGORIES.filter((c) => rawSelection.includes(c)) : ALL_CATEGORIES;
const categoriesForPrompt = ACTIVE_CATEGORIES.length > 0 ? ACTIVE_CATEGORIES : ALL_CATEGORIES;

const categoryInstruction =
  categoriesForPrompt.length === ALL_CATEGORIES.length
    ? `Every story's "category" field must be exactly one of these six values, verbatim, no variations: ${categoriesForPrompt.map((c) => `"${c}"`).join(", ")}. Try to find one strong story per category so all six are represented across the day's six stories — but never force a weak or vague story just to fill a category; if you can only find genuinely good stories in four of the six categories, it's fine to use two categories twice rather than include a weak fifth or sixth story.`
    : `The person reading this has asked to see ONLY these categories: ${categoriesForPrompt.map((c) => `"${c}"`).join(", ")}. Every one of the 6 stories must have its "category" field set to one of exactly these values, verbatim — do not include any other category. Find 6 distinct, non-repetitive stories within this narrower set (different subtopics, angles, or institutions), rather than 6 near-duplicates of the same news item. If genuinely fewer than 6 strong, distinct stories exist in the last 7 days across these categories, it's fine to return fewer than 6 rather than pad with weak ones.`;

const DISPATCH_SYSTEM_PROMPT = `You are a careful news curator for a small daily app called "Bright Wire" that shows one dispatch at a time about genuine, current, real-world BENEFITS of AI — not AI industry/business news (funding, pricing, model launches, politics) unless it directly and concretely helps people.

Use web search to find real stories from roughly the last 7 days about AI producing a concrete positive outcome. Prefer credible outlets and primary sources. Order the array with the single most significant, well-sourced story first — that one will be used as the day's push notification headline, so it should be the strongest, most concrete, least hype-y pick.

${categoryInstruction}

Return ONLY a raw JSON array (no markdown code fences, no commentary before or after) of up to 6 objects, each shaped exactly like this:
{
  "category": "One of the exact category values given above",
  "headline": "A simple, plain-English headline under 90 characters that YOU write fresh — never lifted or lightly reworded from the source's own headline. Someone with zero background in the topic should understand what happened from this line alone. Avoid jargon, acronyms, and proper nouns unless essential.",
  "dek": "One plain sentence of extra context, your own words",
  "paragraphs": ["First paragraph (2-3 sentences): the high-level gist in plain language, as if to a smart friend with no background in the field — what happened, in the simplest accurate terms, before any technical detail.", "Second paragraph (2-3 sentences): the supporting detail, numbers, or nuance a more curious reader would want — still your own words, never copied from any source."],
  "whyItMatters": "One sentence on why this matters, your own words, hedge appropriately if the claim is a single company's unverified announcement",
  "source": { "name": "Publication or outlet name", "url": "A real URL that actually appeared in your search results" }
}

Rules: paraphrase everything, never quote a source directly, use only URLs you actually found via search, use only the exact category values given, write headlines that are your own simplified plain-English summary rather than a close rewrite of the source's headline, and output nothing but the JSON array.`;

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
  let stories;
  try {
    stories = await fetchTodaysStories();
  } catch (err) {
    console.warn(`First attempt failed (${err.message}); retrying once...`);
    stories = await fetchTodaysStories();
  }
  const lead = stories[0];

  const fs = await import("node:fs/promises");
  await fs.mkdir("data", { recursive: true });
  const key = todayKey(TIMEZONE);
  const payload = { date: key, fetchedAt: new Date().toISOString(), stories };
  await fs.writeFile(`data/${key}.json`, JSON.stringify(payload, null, 2));
  await fs.writeFile("data/latest.json", JSON.stringify(payload, null, 2));
  console.log(`Saved data/${key}.json and data/latest.json`);

  // Rebuild the manifest of every date that has an edition, newest
  // first, by reading the data/ directory itself rather than trusting
  // the manifest's own past writes — this makes it self-healing and
  // automatically backfills any dated files that existed before this
  // indexing logic was added.
  const files = await fs.readdir("data");
  const dates = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.replace(".json", ""))
    .sort()
    .reverse();
  await fs.writeFile("data/index.json", JSON.stringify(dates, null, 2));
  console.log(`Rebuilt data/index.json (${dates.length} editions on file)`);

  await sendNotification(lead);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Bright Wire run failed:", err);
  process.exit(1);
});
