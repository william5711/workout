// Same Supabase project and sign-in as Plan and Pocket. Workout keeps its data in its own wk_* tables.
// The publishable key is meant to be public: your data is protected by sign-in and the row rules in setup.sql.
window.WK_CONFIG = {
  supabaseUrl: "https://yjzlpgiklxrnimqzdbjt.supabase.co",
  supabaseAnonKey: "sb_publishable_kGyOVxrlssDSx1UuzPAYZg_keW59ehn",
  // Public half of the Web Push key pair (the private half is the VAPID_PRIVATE_KEY secret on the workout-push function).
  vapidPublicKey: "BCpP6zwkvPz-vPqieyf6hIaET3yckXzOMGeJCSohaJ20oVSebQwwG8KROsNBgQZ4yb75FmGcDmk2yN0j77J9Xu8",
};
