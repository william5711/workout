# Workout

A phone-first workout tracker, built the same way as Plan: a static page on GitHub Pages, with data in the same Supabase project and the same sign-in. It keeps its data in its own `wk_*` tables.

- **Today:** the set you're on, what's next, your streak, a rest timer, weekly strength/cardio/stretch rings and a suggestion.
- **Log:** each day's workouts. Tap a set to tick it off. Type exercises one per line, like `Bench press: 4x8 @135` or `Run: 20 min`.
- **Progress:** a muscle recovery map, a personal-record line per lift, a 5-week streak calendar and a weekly recap.
- **Claude:** chat in the Claude app and Claude plans or changes your workouts directly. Every change shows up here with Undo.

Open `index.html?preview` to try it with sample data. Nothing is saved in preview mode.

## Setup

1. **Database:** in Supabase → SQL Editor, run [`setup.sql`](setup.sql). It's safe to run again.
2. **Host:** push this folder to a new GitHub repository (for example `workout`) and turn on Pages for `main`. Add the address to Supabase → Authentication → URL Configuration → Redirect URLs.
3. **Connector:** in Supabase → Edge Functions → Deploy a new function → Via editor, name it `workout-mcp`, paste [`supabase/functions/workout-mcp/index.ts`](supabase/functions/workout-mcp/index.ts), deploy, and turn **off** JWT verification in its Details.
4. **Claude app:** in Workout's Claude tab, create the connector link and copy it. On claude.ai, go to Settings → Connectors → Add custom connector, name it `Workout`, paste the link and choose **No sign-in**.

Turn on both Workout and Plan in a chat, and Claude can plan your training and put the sessions on your schedule in one go:
- "Plan next week: 4 lifting days and 2 runs, around my classes."
- "My knee hurts, swap Saturday's leg day for upper body."
- "I did 5x5 squats at 195 today, log it."

## What Claude can do

| Tool | What it does |
|---|---|
| `get_training` | Goal, weekly targets, recent and planned workouts, days since each muscle was trained, best lifts |
| `add_workouts` | Plans or logs workouts (up to 21 at once) |
| `update_workouts` | Moves, edits, marks done or skipped |
| `delete_workouts` | Removes workouts (only when you ask) |
| `set_profile` | Saves your goal, weekly targets and notes (split, injuries, preferred times) |

The connector link works like a password. Turn it off or make a new one in the Claude tab.
