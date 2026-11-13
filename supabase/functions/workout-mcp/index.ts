// Workout connector: a small MCP server that lets Claude (in the Claude app) read your training and plan or change workouts.
// Runs as a Supabase Edge Function. Deploy with "Verify JWT" turned OFF: the secret link itself is the sign-in.
// Connector URL: https://<project>.supabase.co/functions/v1/workout-mcp/<secret from the app's Claude tab>
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

// ==== CORE START (no Supabase or Deno below this line until CORE END) ====
const SERVER_INFO = { name: "workout", title: "Workout", version: "1.0.0" };
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const KINDS = ["strength", "cardio", "stretch"];
const MUSCLES = ["chest", "back", "shoulders", "arms", "core", "legs"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INSTRUCTIONS = `This connector is the user's workout tracker ("Workout"). The app on their phone shows today's workout set by set, a muscle recovery map, personal records and a streak.
How to use it:
- Call get_training first, every time: it gives today's date, the user's goal, weekly targets (strength / cardio / stretch sessions), notes (injuries, split, preferred times), recent and planned workouts, days since each muscle group was trained, and best lifts.
- When the user talks about their training plans, change the workout plan directly with add_workouts / update_workouts. Don't just describe a plan; put it in the app.
- Balance the week against the targets. Don't train a muscle group again within 48 hours of a hard session. Add a short stretch after strength days when stretch is behind target. Progress weights gradually (about 2.5-5% or +5 lb on upper body, +10 lb on lower body when all sets were completed last time).
- Each strength exercise needs sets, reps and usually a weight in lb. Cardio and stretching use minutes.
- If the Plan connector (the user's day planner) is also available and the user wants workouts on their schedule, add a matching time block there too with Plan's add_tasks, keeping Plan's own rules (call its get_schedule first, avoid fixed blocks).
- After changing anything, tell the user briefly what changed. Every change is logged in the app with an Undo button.
- Don't delete workouts the user didn't ask to remove. Mark finished ones done, or skipped if they missed them.`;

const EX_SCHEMA = { type: "object", additionalProperties: false, required: ["name"], properties: {
  name: { type: "string", minLength: 1, maxLength: 80, description: "e.g. \"Bench press\", \"Run\", \"Hip flexor stretch\"." },
  muscle: { type: "string", enum: MUSCLES, description: "Main muscle group for strength exercises." },
  sets: { type: "integer", minimum: 1, maximum: 12 },
  reps: { type: "integer", minimum: 1, maximum: 100 },
  weight: { type: ["number", "null"], minimum: 0, maximum: 2000, description: "Pounds per rep, or null for bodyweight." },
  minutes: { type: "integer", minimum: 1, maximum: 600, description: "For cardio and stretching." },
} };
const WK_FIELDS = {
  date: { type: "string", description: "YYYY-MM-DD in the user's time zone." },
  title: { type: "string", minLength: 1, maxLength: 120, description: "e.g. \"Push day\", \"Easy run\"." },
  kind: { type: "string", enum: KINDS },
  status: { type: "string", enum: ["planned", "done", "skipped"] },
  exercises: { type: "array", maxItems: 20, items: EX_SCHEMA, description: "Replaces the whole list when updating." },
  notes: { type: "string", maxLength: 2000 },
};

const TOOLS = [
  { name: "get_training", title: "Get training",
    description: "Read the user's goal, weekly targets, notes, workouts in a window around today (done, planned and skipped), this week's counts vs targets, days since each muscle group was trained, and best weight per lift. Call this before suggesting or changing anything.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      days_back: { type: "integer", minimum: 0, maximum: 90, description: "Past days to include. Default 14." },
      days_ahead: { type: "integer", minimum: 0, maximum: 60, description: "Future days to include. Default 14." },
    } }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: "add_workouts", title: "Add workouts",
    description: "Plan (or log) one or more workouts. Each needs a date and title; give its kind and exercises. Use status \"done\" to log a workout the user already did.",
    inputSchema: { type: "object", additionalProperties: false, required: ["workouts"], properties: {
      workouts: { type: "array", minItems: 1, maxItems: 21, items: { type: "object", additionalProperties: false, required: ["date", "title"], properties: WK_FIELDS } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  { name: "update_workouts", title: "Change workouts",
    description: "Move, edit, mark done or skipped by id (ids come from get_training). Only fields you pass change; exercises replaces the full list (sets already ticked off keep their ticks when the exercise name and set count match).",
    inputSchema: { type: "object", additionalProperties: false, required: ["updates"], properties: {
      updates: { type: "array", minItems: 1, maxItems: 21, items: { type: "object", additionalProperties: false, required: ["id"], properties: { id: { type: "string" }, ...WK_FIELDS } } } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "delete_workouts", title: "Remove workouts",
    description: "Remove workouts by id. Only when the user wants them gone. For missed workouts use update_workouts with status \"skipped\".",
    inputSchema: { type: "object", additionalProperties: false, required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 21, items: { type: "string" } } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
  { name: "set_profile", title: "Update goal and targets",
    description: "Save the user's training goal, weekly session targets, standing notes (split, injuries, equipment, preferred times) or time zone. Notes replace the existing notes, so include anything worth keeping.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      goal: { type: "string", maxLength: 200, description: "e.g. \"build muscle\", \"lose fat\", \"run a 10k\"." },
      targets: { type: "object", additionalProperties: false, properties: Object.fromEntries(KINDS.map(k => [k, { type: "integer", minimum: 0, maximum: 14 }])), description: "Sessions per week by kind." },
      notes: { type: "string", maxLength: 2000 },
      timezone: { type: "string", description: "IANA name, e.g. America/Los_Angeles." },
    } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
];

class ToolError extends Error {}
const fail = (m) => { throw new ToolError(m); };
function isDate(s) { if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + "T00:00:00Z"); return !isNaN(d) && d.toISOString().slice(0, 10) === s; }
function addDays(s, n) { const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function between(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 864e5); }
function weekday(s) { return DAYS[new Date(s + "T00:00:00Z").getUTCDay()]; }
function weekStart(s) { return addDays(s, -((new Date(s + "T00:00:00Z").getUTCDay() + 6) % 7)); }
function validTz(tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
function clockIn(tz, now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}
function dayWords(d, today) { return d === today ? "today" : d === addDays(today, 1) ? "tomorrow" : new Date(d + "T00:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }); }

const exDone = (e) => e.sets?.length ? e.sets.every(s => s.done) : !!e.done;
const active = (s) => s.status === "done" || (s.exercises || []).some(e => exDone(e) || (e.sets || []).some(x => x.done));

// Tool exercise input → stored exercise. Keeps ticks from the old version when name and set count match.
function toExercises(list, old, where) {
  if (!Array.isArray(list)) fail(`${where}: exercises must be a list.`);
  if (list.length > 20) fail(`${where}: at most 20 exercises.`);
  return list.map((x, i) => {
    const w = `${where}.exercises[${i}]`;
    const name = typeof x?.name === "string" ? x.name.trim() : "";
    if (!name || name.length > 80) fail(`${w}: name must be 1-80 characters.`);
    if (x.muscle !== undefined && !MUSCLES.includes(x.muscle)) fail(`${w}: muscle must be one of ${MUSCLES.join(", ")}.`);
    const prev = (old || []).find(e => e.name.toLowerCase() === name.toLowerCase());
    if (x.sets !== undefined || x.reps !== undefined) {
      const n = x.sets ?? 3, r = x.reps ?? 10, wt = x.weight ?? null;
      if (!Number.isInteger(n) || n < 1 || n > 12) fail(`${w}: sets must be 1-12.`);
      if (!Number.isInteger(r) || r < 1 || r > 100) fail(`${w}: reps must be 1-100.`);
      if (wt !== null && (typeof wt !== "number" || wt < 0 || wt > 2000)) fail(`${w}: weight must be 0-2000 lb or null.`);
      const keep = prev?.sets?.length === n;
      const sets = Array.from({ length: n }, (_, k) => ({ w: wt, r, done: keep ? !!prev.sets[k].done : false }));
      return { name, muscle: x.muscle ?? null, type: "strength", sets, min: null, done: sets.every(s => s.done) };
    }
    if (x.minutes !== undefined && (!Number.isInteger(x.minutes) || x.minutes < 1 || x.minutes > 600)) fail(`${w}: minutes must be 1-600.`);
    const type = /stretch|yoga|mobility|foam/i.test(name) ? "stretch" : "cardio";
    return { name, muscle: null, type, sets: [], min: x.minutes ?? null, done: !!prev?.done && !prev?.sets?.length };
  });
}
function markAll(ex, done) { return ex.map(e => ({ ...e, done, sets: (e.sets || []).map(s => ({ ...s, done })) })); }

function toRow(input, partial, where, old) {
  const row = {}, has = (k) => Object.prototype.hasOwnProperty.call(input, k);
  if (!partial || has("date")) { if (!isDate(input.date)) fail(`${where}: date must be YYYY-MM-DD.`); row.day = input.date; }
  if (!partial || has("title")) { const t = typeof input.title === "string" ? input.title.trim() : ""; if (!t || t.length > 120) fail(`${where}: title must be 1-120 characters.`); row.title = t; }
  if (has("kind")) { if (!KINDS.includes(input.kind)) fail(`${where}: kind must be strength, cardio or stretch.`); row.kind = input.kind; }
  if (has("status")) { if (!["planned", "done", "skipped"].includes(input.status)) fail(`${where}: status must be planned, done or skipped.`); row.status = input.status; }
  if (has("exercises")) row.exercises = toExercises(input.exercises, old?.exercises, where);
  if (has("notes")) { if (typeof input.notes !== "string" || input.notes.length > 2000) fail(`${where}: notes must be text up to 2000 characters.`); row.notes = input.notes; }
  const status = row.status ?? old?.status;
  if (status === "done" && (row.exercises || (has("status") && old))) row.exercises = markAll(row.exercises ?? old.exercises, true);
  return row;
}
function guessKind(ex) { return ex?.length && ex.every(e => e.type === "stretch") ? "stretch" : ex?.length && ex.every(e => e.type !== "strength") ? "cardio" : "strength"; }

function out(s) {
  return { id: s.id, date: s.day, weekday: weekday(s.day), title: s.title, kind: s.kind, status: s.status,
    exercises: (s.exercises || []).map(e => e.sets?.length
      ? { name: e.name, muscle: e.muscle, sets: e.sets.length, reps: e.sets[0].r, weight: e.sets[0].w, sets_done: e.sets.filter(x => x.done).length }
      : { name: e.name, minutes: e.min, done: !!e.done }),
    ...(s.notes ? { notes: s.notes } : {}), added_by: s.source };
}
function describe(before, after, today) {
  if (before.status !== after.status) return `Marked “${after.title}” ${after.status}`;
  if (before.day !== after.day) return `Moved “${after.title}” to ${dayWords(after.day, today)}`;
  if (JSON.stringify(before.exercises) !== JSON.stringify(after.exercises)) return `Changed exercises in “${after.title}”`;
  return `Edited “${after.title}”`;
}

async function profileOf(store, uid) {
  const p = await store.getProfile(uid);
  return { timezone: "America/Los_Angeles", goal: "general fitness", targets: { strength: 4, cardio: 2, stretch: 3 }, notes: "", ...(p || {}) };
}

async function callTool(name, args, ctx) {
  const { store, uid } = ctx, now = ctx.now || new Date();
  args = args && typeof args === "object" ? args : {};
  const prof = await profileOf(store, uid), clock = clockIn(prof.timezone, now), today = clock.date;

  if (name === "get_training") {
    const back = args.days_back ?? 14, ahead = args.days_ahead ?? 14;
    if (!Number.isInteger(back) || back < 0 || back > 90 || !Number.isInteger(ahead) || ahead < 0 || ahead > 60) fail("days_back must be 0-90 and days_ahead 0-60.");
    const all = await store.listRange(uid, addDays(today, -90), addDays(today, ahead));
    const shown = all.filter(s => s.day >= addDays(today, -back));
    const last = {}; for (const m of MUSCLES) last[m] = null;
    const best = {};
    for (const s of all) if (s.day <= today && active(s)) for (const e of s.exercises || []) {
      if (e.muscle && (exDone(e) || e.sets?.some(x => x.done))) { const d = between(s.day, today); if (last[e.muscle] === null || d < last[e.muscle]) last[e.muscle] = d; }
      for (const x of e.sets || []) if (x.done && x.w && (!best[e.name] || x.w > best[e.name].weight)) best[e.name] = { weight: x.w, reps: x.r, date: s.day };
    }
    const ws = weekStart(today), counts = { strength: 0, cardio: 0, stretch: 0 };
    for (const s of all) if (s.status === "done" && s.day >= ws && s.day <= addDays(ws, 6)) counts[s.kind]++;
    let streak = 0, d = all.some(s => s.day === today && active(s)) ? today : addDays(today, -1);
    while (all.some(s => s.day === d && active(s))) { streak++; d = addDays(d, -1); }
    return {
      today, weekday: weekday(today), now: clock.time, timezone: prof.timezone,
      profile: { goal: prof.goal, weekly_targets: prof.targets, notes: prof.notes || null },
      this_week: { starts: ws, done: counts, targets: prof.targets }, streak_days: streak,
      days_since_trained: last, best_lifts: best,
      workouts: shown.map(out),
    };
  }

  if (name === "add_workouts") {
    const items = Array.isArray(args.workouts) ? args.workouts : fail("workouts must be a list.");
    if (!items.length || items.length > 21) fail("Add between 1 and 21 workouts at a time.");
    const rows = items.map((it, i) => {
      if (!it || typeof it !== "object") fail(`workouts[${i}] must be an object.`);
      const r = { status: "planned", notes: "", exercises: [], ...toRow(it, false, `workouts[${i}]`, null) };
      if (r.status === "done") r.exercises = markAll(r.exercises, true);
      r.kind = r.kind || guessKind(r.exercises);
      return r;
    });
    const added = [];
    for (const r of rows) {
      const s = await store.insert(uid, r); added.push(s);
      await store.logChange(uid, { session_id: s.id, action: "add", before: null, after: s, summary: `${s.status === "done" ? "Logged" : "Planned"} “${s.title}” ${dayWords(s.day, today)}` });
    }
    return { added: added.map(out) };
  }

  if (name === "update_workouts") {
    const items = Array.isArray(args.updates) ? args.updates : fail("updates must be a list.");
    if (!items.length || items.length > 21) fail("Change between 1 and 21 workouts at a time.");
    const plans = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      if (!UUID.test(String(it.id || ""))) fail(`updates[${i}]: "${it.id}" isn't a workout id. Use ids from get_training.`);
      const { id, ...rest } = it;
      if (!Object.keys(rest).length) fail(`updates[${i}]: nothing to change.`);
      const before = await store.get(uid, id);
      if (!before) fail(`updates[${i}]: no workout with id ${id}. Call get_training again.`);
      plans.push({ id, before, row: toRow(rest, true, `updates[${i}]`, before) });
    }
    const updated = [];
    for (const p of plans) {
      const after = await store.update(uid, p.id, p.row); updated.push(after);
      await store.logChange(uid, { session_id: p.id, action: "update", before: p.before, after, summary: describe(p.before, after, today) });
    }
    return { updated: updated.map(out) };
  }

  if (name === "delete_workouts") {
    const ids = Array.isArray(args.ids) ? args.ids : fail("ids must be a list.");
    if (!ids.length || ids.length > 21) fail("Remove between 1 and 21 workouts at a time.");
    const removed = [], missing = [];
    for (const id of ids) {
      const before = UUID.test(String(id)) ? await store.get(uid, id) : null;
      if (!before) { missing.push(String(id)); continue; }
      await store.remove(uid, id);
      await store.logChange(uid, { session_id: id, action: "delete", before, after: null, summary: `Removed “${before.title}” (${dayWords(before.day, today)})` });
      removed.push({ id, title: before.title });
    }
    return { removed, ...(missing.length ? { not_found: missing } : {}) };
  }

  if (name === "set_profile") {
    const patch = {};
    if (args.goal !== undefined) { if (typeof args.goal !== "string" || args.goal.length > 200) fail("goal must be text up to 200 characters."); patch.goal = args.goal.trim() || "general fitness"; }
    if (args.targets !== undefined) {
      if (!args.targets || typeof args.targets !== "object") fail("targets must be an object like {\"strength\":4}.");
      const t = { ...prof.targets };
      for (const [k, v] of Object.entries(args.targets)) { if (!KINDS.includes(k) || !Number.isInteger(v) || v < 0 || v > 14) fail("targets: strength, cardio and stretch must be 0-14."); t[k] = v; }
      patch.targets = t;
    }
    if (args.notes !== undefined) { if (typeof args.notes !== "string" || args.notes.length > 2000) fail("notes must be text up to 2000 characters."); patch.notes = args.notes.trim(); }
    if (args.timezone !== undefined) { if (typeof args.timezone !== "string" || !validTz(args.timezone)) fail("timezone must be an IANA name like America/Los_Angeles."); patch.timezone = args.timezone; }
    if (!Object.keys(patch).length) fail("Nothing to change.");
    const n = { ...prof, ...patch };
    const saved = await store.upsertProfile(uid, { goal: n.goal, targets: n.targets, notes: n.notes, timezone: n.timezone });
    return { profile: { goal: saved.goal, weekly_targets: saved.targets, notes: saved.notes || null, timezone: saved.timezone } };
  }
  fail(`Unknown tool: ${name}`);
}

async function handleRpc(msg, ctx) {
  const isReq = msg && typeof msg === "object" && msg.jsonrpc === "2.0" && typeof msg.method === "string";
  const id = msg && Object.prototype.hasOwnProperty.call(msg, "id") ? msg.id : undefined;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  if (!isReq) return error(-32600, "Invalid request");
  if (id === undefined) return null;
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[1], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      if (!TOOLS.some(t => t.name === p.name)) return error(-32602, `Unknown tool: ${p.name}`);
      try { return reply({ content: [{ type: "text", text: JSON.stringify(await callTool(p.name, p.arguments, ctx)) }] }); }
      catch (e) {
        if (e instanceof ToolError) return reply({ content: [{ type: "text", text: e.message }], isError: true });
        console.error(e); return reply({ content: [{ type: "text", text: "The workout database had a problem. Try again in a moment." }], isError: true });
      }
    }
    case "resources/list": return reply({ resources: [] });
    case "prompts/list": return reply({ prompts: [] });
    default: return error(-32601, `Method not found: ${msg.method}`);
  }
}

async function sha256Hex(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }

async function handleHttp(req, store) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version, mcp-session-id", "Access-Control-Allow-Methods": "POST, OPTIONS" };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("This connector only accepts MCP POST requests.", { status: 405, headers: { ...cors, Allow: "POST, OPTIONS" } });
  const token = new URL(req.url).pathname.split("/").filter(Boolean).pop() || "";
  const uid = token.length >= 20 && token !== "workout-mcp" ? await store.userForTokenHash(await sha256Hex(token)) : null;
  if (!uid) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This connector link isn't valid. Make a new one in the Workout app's Claude tab." } }, 401);
  let body; try { body = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  const ctx = { store, uid };
  if (Array.isArray(body)) { const res = (await Promise.all(body.map(m => handleRpc(m, ctx)))).filter(Boolean); return res.length ? json(res) : new Response(null, { status: 202, headers: cors }); }
  const res = await handleRpc(body, ctx);
  return res ? json(res) : new Response(null, { status: 202, headers: cors });
}
// ==== CORE END ====

const COLS = "id,day,title,kind,status,exercises,notes,source,created_at,updated_at";
function serverKey() {
  try { const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); const k = keys.default || Object.values(keys)[0]; if (k) return k; } catch { /* legacy key */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}
const db = createClient(Deno.env.get("SUPABASE_URL"), serverKey(), { auth: { persistSession: false } });
const must = (r) => { if (r.error) throw r.error; return r.data; };
const store = {
  async userForTokenHash(h) { return must(await db.from("wk_connector").select("user_id").eq("token_hash", h).maybeSingle())?.user_id || null; },
  async getProfile(uid) { return must(await db.from("wk_profile").select("*").eq("user_id", uid).maybeSingle()); },
  async upsertProfile(uid, p) { return must(await db.from("wk_profile").upsert({ user_id: uid, ...p }).select("*").single()); },
  async listRange(uid, from, to) { return must(await db.from("wk_sessions").select(COLS).eq("user_id", uid).gte("day", from).lte("day", to).order("day")); },
  async get(uid, id) { return must(await db.from("wk_sessions").select(COLS).eq("user_id", uid).eq("id", id).maybeSingle()); },
  async insert(uid, row) { return must(await db.from("wk_sessions").insert({ ...row, user_id: uid, source: "claude" }).select(COLS).single()); },
  async update(uid, id, row) { return must(await db.from("wk_sessions").update(row).eq("user_id", uid).eq("id", id).select(COLS).single()); },
  async remove(uid, id) { must(await db.from("wk_sessions").delete().eq("user_id", uid).eq("id", id)); },
  async logChange(uid, c) { must(await db.from("wk_changes").insert({ user_id: uid, ...c })); },
};

Deno.serve(async (req) => {
  const res = await handleHttp(req, store);
  console.log(JSON.stringify({ http: req.method, status: res.status }));
  return res;
});
