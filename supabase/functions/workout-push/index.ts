// Workout push: sends the "Rest's over" lock-screen notification.
// The app calls this when a rest timer starts (signed in, so keep JWT verification ON).
// It waits in the background, then sends a Web Push to each of the user's devices, but only if the rest
// wasn't skipped (the app deletes or replaces the wk_rest row when you skip or start another timer).
// Secrets needed (Edge Functions → Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import webpush from "npm:web-push@3.6.7";

function serverKey() {
  try { const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); const k = keys.default || Object.values(keys)[0]; if (k) return k; } catch { /* legacy key */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, serverKey()!, { auth: { persistSession: false } });
webpush.setVapidDetails("https://william5711.github.io/workout/", Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendLater(uid: string, token: string, delay: number, title: string, body: string) {
  await sleep(delay * 1000);
  const { data: row } = await db.from("wk_rest").select("token").eq("user_id", uid).maybeSingle();
  if (!row || row.token !== token) return;                         // skipped or replaced by a newer timer
  await db.from("wk_rest").delete().eq("user_id", uid).eq("token", token);
  const { data: subs } = await db.from("wk_push").select("endpoint, sub").eq("user_id", uid);
  for (const s of subs || []) {
    try { await webpush.sendNotification(s.sub, JSON.stringify({ title, body }), { TTL: 120, urgency: "high" }); }
    catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("wk_push").delete().eq("endpoint", s.endpoint);   // device unsubscribed
      else console.error("push failed", code, (e as Error).message);
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await db.auth.getUser(jwt);
  if (!user) return json({ error: "Sign in first" }, 401);
  let b: { delay?: number; token?: string; title?: string; body?: string };
  try { b = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }
  const delay = Math.max(0, Math.min(140, Number(b.delay) || 90));
  if (!b.token || !/^[0-9a-f-]{36}$/i.test(b.token)) return json({ error: "token required" }, 400);
  const title = String(b.title || "Rest's over").slice(0, 80), body = String(b.body || "").slice(0, 200);
  // Keep running after we reply (Supabase background task).
  // @ts-ignore EdgeRuntime is provided by Supabase
  EdgeRuntime.waitUntil(sendLater(user.id, b.token, delay, title, body));
  return json({ scheduled: true, in_seconds: delay }, 202);
});
