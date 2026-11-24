// Verified Bale user-to-seller links for the opt-in coach.
// Name-based self registration in the legacy bonus bot is NOT sufficient authorization.
const INIT_SQL = `CREATE TABLE IF NOT EXISTS coach_verified_links(
 user_id TEXT PRIMARY KEY,
 seller_key TEXT NOT NULL,
 approved_by TEXT NOT NULL,
 approved_at TEXT DEFAULT CURRENT_TIMESTAMP
)`;
const validUserId = (id) => /^[0-9]{1,20}$/.test(String(id ?? ""));

export async function ensureCoachVerificationTable(env) {
  await env.DB.prepare(INIT_SQL).run();
}

export async function verifiedCoachSeller(env, userId) {
  if (!validUserId(userId)) return null;
  await ensureCoachVerificationTable(env);
  const row = await env.DB.prepare(
    `SELECT p.* FROM coach_verified_links AS v
     JOIN aban_people AS p ON p.seller_key=v.seller_key
     WHERE v.user_id=? LIMIT 1`
  ).bind(String(userId)).first();
  return row || null;
}

// Only call this after an administrator has been authenticated on the server.
// A seller's own choice of name cannot create this association.
export async function approveCoachSeller(env, userId, sellerKey, approverId) {
  if (!validUserId(userId) || !validUserId(approverId) || !sellerKey)
    return {ok:false,error:"invalid_identity"};
  await ensureCoachVerificationTable(env);
  const exists = await env.DB.prepare(
    "SELECT seller_key FROM aban_people WHERE seller_key=?"
  ).bind(String(sellerKey)).first();
  if (!exists) return {ok:false,error:"seller_not_found"};
  const current = await env.DB.prepare(
    "SELECT seller_key FROM coach_verified_links WHERE user_id=?"
  ).bind(String(userId)).first();
  if (current && current.seller_key !== String(sellerKey))
    return {ok:false,error:"already_assigned"};
  // Prevent two users from concurrently claiming the same seller record.
  const other = await env.DB.prepare(
    "SELECT user_id FROM coach_verified_links WHERE seller_key=? AND user_id<>?"
  ).bind(String(sellerKey),String(userId)).first();
  if (other) return {ok:false,error:"seller_already_assigned"};
  await env.DB.prepare(
    "INSERT OR IGNORE INTO coach_verified_links(user_id,seller_key,approved_by) VALUES(?,?,?)"
  ).bind(String(userId),String(sellerKey),String(approverId)).run();
  return {ok:true};
}
