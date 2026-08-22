# Bright Wire — automated 7am edition

Runs for free on GitHub Actions. Every morning at 7:00 America/Toronto time it:

1. Calls the Anthropic API with web search turned on to find 6 fresh, benefit-focused AI news stories.
2. Saves them to `data/latest.json` (and `data/YYYY-MM-DD.json`) in this repo.
3. Pushes a phone notification with the lead story via [ntfy.sh](https://ntfy.sh) — a free push service, no account needed.

No server to run or pay for — GitHub's scheduler does the waking-up part.

## Setup (about 10 minutes)

**1. Create the repo**
Push this folder to a new GitHub repo (private is fine — the workflow works either way).

**2. Get an Anthropic API key**
From [console.anthropic.com](https://console.anthropic.com) → API Keys. This is billed separately from your claude.ai plan — one run costs a few cents at most (one Sonnet call with web search, once a day).

**3. Pick an ntfy.sh topic and install the app**
- Install the **ntfy** app: [App Store](https://apps.apple.com/app/ntfy/id1625396347) or [Play Store](https://play.google.com/store/apps/details?id=io.heckel.ntfy).
- Pick a topic name only you would guess — e.g. `ruchir-bright-wire-8f2k1` (anyone who knows the exact topic name can subscribe or post to it, since ntfy topics aren't private accounts).
- In the app, tap **Subscribe to topic** and enter that same name.

**4. Add two GitHub secrets**
In your repo: Settings → Secrets and variables → Actions → New repository secret.
- `ANTHROPIC_API_KEY` — the key from step 2
- `NTFY_TOPIC` — the topic name from step 3

**5. Turn it on**
The workflow (`.github/workflows/daily-brightwire.yml`) is already scheduled hourly and self-gates to only act at 7am Toronto time. Nothing else to enable — GitHub Actions runs on push automatically. Optionally test it immediately:
Actions tab → "Bright Wire daily edition" → **Run workflow** (the manual trigger defaults to `force: true`, so it'll fetch and notify right away regardless of the current time).

## Changing the time or timezone

Edit the `env:` block in the workflow file:
```yaml
BRIGHT_WIRE_TIMEZONE: "America/Toronto"
BRIGHT_WIRE_HOUR: "7"
```
Any [IANA timezone name](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) works. The hourly cron + local-hour check means DST transitions are handled automatically — no cron math needed.

## Viewing the archive / building a real UI on top

Every day's edition is saved as JSON in `data/`. If you turn on GitHub Pages for this repo (Settings → Pages → deploy from branch), `data/latest.json` becomes fetchable at:
```
https://<your-username>.github.io/<repo-name>/data/latest.json
```
The Bright Wire artifact from earlier in this conversation can be pointed at that URL instead of calling the Anthropic API itself, so opening the web app becomes instant (reads the pre-fetched file) rather than triggering a live search. Ask if you'd like that version wired up.

## Costs
- GitHub Actions: free tier covers this easily (24 short runs/day, one real run).
- Anthropic API: roughly $0.01–0.05/day depending on search volume.
- ntfy.sh: free.
