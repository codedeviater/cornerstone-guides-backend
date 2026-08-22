import express from "express";
import cors from "cors";
import pg from "pg";
import { verifyToken } from "@clerk/backend";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let dbReady = false;
async function initDb() {
  if (dbReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS applications (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      student_id TEXT NOT NULL,
      reasons TEXT[],
      other_reason TEXT,
      coding_experience INTEGER,
      status TEXT NOT NULL DEFAULT 'new',
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Applications now require a signed-in account, so we log who submitted
  // each one (email is required; username/clerk id are stored for lookup
  // and so the applicant can be identified/contacted).
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`ALTER TABLE applications ADD COLUMN IF NOT EXISTS clerk_user_id TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS application_messages (
      id SERIAL PRIMARY KEY,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guides (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      subject TEXT,
      section TEXT,
      body TEXT NOT NULL DEFAULT '',
      published BOOLEAN NOT NULL DEFAULT true,
      author_id TEXT,
      author_username TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`ALTER TABLE guides ADD COLUMN IF NOT EXISTS section TEXT`);
  await pool.query(`ALTER TABLE guides ADD COLUMN IF NOT EXISTS author_username TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS staff (
      username TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Staff was previously keyed by a column literally named "email", but it
  // was always populated with usernames in practice (that's what the old,
  // working version compared against) — so we copy that data straight into
  // the new username column rather than asking anyone to re-enter it.
  await pool.query(`ALTER TABLE staff ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`UPDATE staff SET username = email WHERE username IS NULL AND email IS NOT NULL`);
  // The column above may have come in on a table that already existed
  // (pre-username-migration), which means it has no uniqueness constraint —
  // and "Add staff" relies on ON CONFLICT (username), which requires one.
  // Add it if missing, without erroring on repeat deploys. Wrapped so that
  // if somehow two rows already share a username, the whole app doesn't
  // fail to boot over it — staff-adding stays broken but everything else
  // keeps working, and it'll show up loudly in logs instead.
  try {
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'staff_username_unique'
        ) THEN
          ALTER TABLE staff ADD CONSTRAINT staff_username_unique UNIQUE (username);
        END IF;
      END $$;
    `);
  } catch (err) {
    console.error("failed to add staff_username_unique constraint:", err);
  }
  // Separate from `staff` on purpose: being staff/editor never implies admin
  // access. This is an explicit, small allowlist of usernames that skip the
  // admin password prompt entirely.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_auto_access (
      username TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classes (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      subject TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  // Best-effort default list of TJHSST courses across grades 9-12, seeded
  // once so the editor's class picker isn't empty on a fresh deploy. This is
  // NOT guaranteed to exactly match the current year's official course
  // catalog (course offerings change yearly) — review/adjust it in the
  // admin Classes tab. Never overwrites anything already added/edited.
  const DEFAULT_CLASSES = [
    // Math
    ["Algebra 2/Trig Honors", "Math"], ["Honors Functions, Analysis, and Trig (Precalculus)", "Math"],
    ["AP Calculus AB", "Math"], ["AP Calculus BC", "Math"], ["Multivariable Calculus", "Math"],
    ["Linear Algebra", "Math"], ["AP Statistics", "Math"], ["Probability & Statistics", "Math"],
    ["Discrete Math", "Math"], ["Number Theory", "Math"],
    // Science (core sequence)
    ["Biology (IBET)", "Science"], ["Chemistry Honors", "Science"], ["Physics Honors", "Science"],
    ["AP Biology", "Science"], ["AP Chemistry", "Science"], ["AP Physics 1", "Science"],
    ["AP Physics C: Mechanics", "Science"], ["AP Physics C: E&M", "Science"], ["AP Environmental Science", "Science"],
    // Computer Science
    ["Foundations of Computer Science Honors", "Computer Science"], ["AP Computer Science A", "Computer Science"],
    ["AP Computer Science Principles", "Computer Science"], ["Data Structures", "Computer Science"],
    ["Computer Systems", "Computer Science"], ["Artificial Intelligence", "Computer Science"],
    ["Machine Learning", "Computer Science"],
    // Research Labs
    ["Artificial Intelligence Lab", "Research"], ["Astronomy & Astrophysics Lab", "Research"],
    ["Biotechnology & Life Sciences Lab", "Research"], ["Computer Systems Lab", "Research"],
    ["Energy Systems Lab", "Research"], ["Engineering Design & Development", "Research"],
    ["Microelectronics Lab", "Research"], ["Multi-Agent Robotics Lab", "Research"],
    ["Neuroscience Lab", "Research"], ["Oceanography & Geophysical Systems Lab", "Research"],
    ["Quantum Information Science Lab", "Research"], ["Systems & Cybersecurity Lab", "Research"],
    ["Signal Processing & Communications Lab", "Research"], ["Materials Science Lab", "Research"],
    // Humanities
    ["Ancient Civilizations Honors", "Social Studies"], ["World History/Geography", "Social Studies"],
    ["African American History", "Social Studies"], ["History of Science Honors", "Social Studies"],
    ["AP European History", "Social Studies"], ["AP Psychology", "Social Studies"],
    ["AP Macroeconomics", "Social Studies"], ["AP Microeconomics", "Social Studies"],
    ["AP US History", "Social Studies"], ["AP US Government & Politics", "Social Studies"],
    ["AP Human Geography", "Social Studies"],
    ["English 9", "English"], ["English 10", "English"], ["English 11", "English"], ["English 12", "English"],
    ["AP English Language", "English"], ["AP English Literature", "English"],
    ["Journalism", "English"], ["Broadcast Journalism", "English"], ["Photojournalism", "English"],
    // World Languages
    ["Spanish 1", "World Languages"], ["Spanish 2", "World Languages"], ["Spanish 3", "World Languages"],
    ["Spanish 4", "World Languages"], ["Spanish 5", "World Languages"], ["AP Spanish Language", "World Languages"],
    ["AP Spanish Literature", "World Languages"],
    ["French 1", "World Languages"], ["French 2", "World Languages"], ["French 3", "World Languages"],
    ["French 4", "World Languages"], ["French 5", "World Languages"], ["AP French Language", "World Languages"],
    ["German 1", "World Languages"], ["German 2", "World Languages"], ["German 3", "World Languages"],
    ["German 4", "World Languages"], ["German 5", "World Languages"], ["AP German Language", "World Languages"],
    ["Latin 1", "World Languages"], ["Latin 2", "World Languages"], ["Latin 3", "World Languages"],
    ["Latin 4", "World Languages"], ["AP Latin", "World Languages"],
    ["Japanese 1", "World Languages"], ["Japanese 2", "World Languages"], ["Japanese 3", "World Languages"],
    ["Japanese 4", "World Languages"], ["Japanese 5", "World Languages"],
    ["Mandarin Chinese 1", "World Languages"], ["Mandarin Chinese 2", "World Languages"],
    ["Mandarin Chinese 3", "World Languages"], ["Mandarin Chinese 4", "World Languages"],
    ["Mandarin Chinese 5", "World Languages"], ["AP Chinese Language", "World Languages"],
    ["Korean 1", "World Languages"], ["Korean 2", "World Languages"], ["Korean 3", "World Languages"],
    ["Korean 4", "World Languages"],
    // Fine Arts
    ["Band", "Fine Arts"], ["Orchestra", "Fine Arts"], ["Chorus", "Fine Arts"], ["Art", "Fine Arts"],
    ["Photography", "Fine Arts"], ["Ceramics", "Fine Arts"], ["AP Studio Art", "Fine Arts"],
    ["AP Music Theory", "Fine Arts"],
    // Health/PE
    ["Health & PE 9", "Health/PE"], ["Health & PE 10", "Health/PE"],
    ["Health & PE 11", "Health/PE"], ["Health & PE 12", "Health/PE"]
  ];
  for (const [name, subject] of DEFAULT_CLASSES) {
    await pool.query(`INSERT INTO classes (name, subject) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [name, subject]);
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_classes (
      student_id TEXT NOT NULL,
      class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (student_id, class_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_activity (
      id SERIAL PRIMARY KEY,
      student_id TEXT NOT NULL,
      guide_id INTEGER REFERENCES guides(id) ON DELETE CASCADE,
      unit_label TEXT,
      last_viewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      subject TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_results (
      id SERIAL PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      student_id TEXT NOT NULL,
      student_name TEXT,
      score INTEGER NOT NULL,
      played_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS archive_items (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT,
      file_data TEXT NOT NULL,
      class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
      uploader_id TEXT NOT NULL,
      uploader_username TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      rejection_reason TEXT,
      reviewed_by TEXT,
      reviewed_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  dbReady = true;
}

const app = express();
app.use(cors());
// Default body-size limit is 100kb, which is far too small once a guide has
// an embedded (base64) image in it — that was silently failing most saves.
// Vercel serverless functions also hard-cap the request body around ~4.5mb
// regardless of this setting, so 4mb here leaves headroom under that cap
// while still being far bigger than the old 100kb default.
app.use(express.json({ limit: "4mb" }));
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "That page is too large to save — try a smaller image or fewer embedded images." });
  }
  next(err);
});
app.use(async (req, res, next) => {
  try {
    await initDb();
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "database init failed" });
  }
});

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// Editor endpoints require both a valid Clerk session AND username membership
// in the staff table — previously this only checked that you were signed in
// at all, and left the actual staff gate to the frontend (which was itself
// checking email against a username-shaped problem). Now it's enforced here,
// by username, server-side.
async function requireEditor(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY
    });
    const username = payload.username || null;
    if (!username) {
      return res.status(401).json({ error: "your account needs a username to use the editor" });
    }
    const staffCheck = await pool.query(`SELECT 1 FROM staff WHERE username = $1`, [username.toLowerCase()]);
    if (staffCheck.rows.length === 0) {
      return res.status(403).json({ error: "not authorized" });
    }
    req.editor = {
      id: payload.sub,
      username
    };
    next();
  } catch (err) {
    res.status(401).json({ error: "unauthorized" });
  }
}

// Any signed-in Clerk user (student or editor) — used for the homepage/student features.
async function requireAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "unauthorized" });
  }
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY
    });
    req.user = {
      id: payload.sub,
      username: payload.username || null,
      email: payload.email || null,
      name: payload.username || payload.name || payload.email || "You"
    };
    next();
  } catch (err) {
    res.status(401).json({ error: "unauthorized" });
  }
}

function slugify(title) {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// Sanitizes a client-supplied permalink/slug. Allows nested paths like
// "multivar/unit4" (segments separated by /), lowercased, safe chars only.
function sanitizeSlug(raw) {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((seg) => seg.replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""))
    .filter(Boolean)
    .join("/");
}

// Applying now requires a signed-in account: the email and username are
// taken from the verified Clerk session rather than typed by the applicant,
// and the application is tied to their account so they can check its status.
app.post("/api/apply", requireAuth, async (req, res) => {
  const { name, studentId, reasons, otherReason, codingExperience, username } = req.body;
  if (!name || !studentId) {
    return res.status(400).json({ error: "name and student id are required" });
  }
  if (!req.user.email) {
    return res.status(400).json({ error: "your account needs a verified email to apply" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO applications (name, student_id, reasons, other_reason, coding_experience, email, username, clerk_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, studentId, reasons || [], otherReason || null, codingExperience || null, req.user.email, username || null, req.user.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save application" });
  }
});

// Lets a signed-in applicant check the status of their own application(s).
app.get("/api/my/applications", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, student_id, reasons, other_reason, coding_experience, status, submitted_at
       FROM applications WHERE clerk_user_id = $1 ORDER BY submitted_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load your applications" });
  }
});

// Message thread on an application, so an admin can ask an applicant a
// follow-up question (or vice versa) without needing their email. Only the
// applicant who owns the application (checked via clerk_user_id) can read
// or post to their own thread.
async function loadOwnedApplication(applicationId, clerkUserId) {
  const result = await pool.query(
    `SELECT id FROM applications WHERE id = $1 AND clerk_user_id = $2`,
    [applicationId, clerkUserId]
  );
  return result.rows[0] || null;
}

app.get("/api/my/applications/:id/messages", requireAuth, async (req, res) => {
  try {
    const owned = await loadOwnedApplication(req.params.id, req.user.id);
    if (!owned) return res.status(404).json({ error: "application not found" });
    const result = await pool.query(
      `SELECT id, sender, body, created_at FROM application_messages
       WHERE application_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load messages" });
  }
});

app.post("/api/my/applications/:id/messages", requireAuth, async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "message body is required" });
  try {
    const owned = await loadOwnedApplication(req.params.id, req.user.id);
    if (!owned) return res.status(404).json({ error: "application not found" });
    const result = await pool.query(
      `INSERT INTO application_messages (application_id, sender, body)
       VALUES ($1, 'applicant', $2) RETURNING id, sender, body, created_at`,
      [req.params.id, body.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to send message" });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    return res.json({ success: true, token: password });
  }
  res.status(401).json({ error: "invalid password" });
});

// Lets a user on the admin_auto_access allowlist skip the password prompt.
// This checks their real Clerk session (not the staff table — being staff
// never grants this on its own), and only ever grants access to usernames
// an existing admin explicitly added.
app.post("/api/admin/auto-login", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "unauthorized" });
  try {
    const payload = await verifyToken(token, { secretKey: process.env.CLERK_SECRET_KEY });
    const username = payload.username || null;
    if (!username) return res.status(403).json({ error: "no auto-access" });
    const result = await pool.query(
      `SELECT 1 FROM admin_auto_access WHERE username = $1`,
      [username.toLowerCase()]
    );
    if (result.rows.length === 0) return res.status(403).json({ error: "no auto-access" });
    res.json({ success: true, token: process.env.ADMIN_PASSWORD });
  } catch (err) {
    res.status(401).json({ error: "unauthorized" });
  }
});

app.get("/api/admin/auto-access", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM admin_auto_access ORDER BY added_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load auto-access list" });
  }
});

app.post("/api/admin/auto-access", requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username is required" });
  try {
    const result = await pool.query(
      `INSERT INTO admin_auto_access (username) VALUES ($1) ON CONFLICT (username) DO NOTHING RETURNING *`,
      [username.toLowerCase().trim()]
    );
    res.json(result.rows[0] || { username: username.toLowerCase().trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to add" });
  }
});

app.delete("/api/admin/auto-access/:username", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM admin_auto_access WHERE username = $1`, [req.params.username.toLowerCase()]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to remove" });
  }
});

app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM applications ORDER BY submitted_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load applications" });
  }
});

app.get("/api/admin/applications/:id/messages", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, sender, body, created_at FROM application_messages
       WHERE application_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load messages" });
  }
});

app.post("/api/admin/applications/:id/messages", requireAdmin, async (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: "message body is required" });
  try {
    const result = await pool.query(
      `INSERT INTO application_messages (application_id, sender, body)
       VALUES ($1, 'admin', $2) RETURNING id, sender, body, created_at`,
      [req.params.id, body.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to send message" });
  }
});

app.patch("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  const { status } = req.body;
  // TODO(future): once an applicant's status changes here, send them an
  // email via Resend (using the `email` column on this row).
  try {
    await pool.query(`UPDATE applications SET status = $1 WHERE id = $2`, [status, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update application" });
  }
});

app.delete("/api/admin/applications/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM applications WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete application" });
  }
});

// ---- Guides backup / restore ----
// Manual download: the admin panel hits this and saves the response as a
// .json file. Automatic: a Vercel Cron job hits /api/cron/backup-guides on
// a schedule and commits this same data to a GitHub repo, so a copy exists
// outside of Neon/Vercel entirely.
async function getAllGuidesForBackup() {
  const result = await pool.query(
    `SELECT id, title, slug, subject, section, body, published, author_id, author_username, created_at, updated_at
     FROM guides ORDER BY id ASC`
  );
  return result.rows;
}

app.get("/api/admin/backup/guides", requireAdmin, async (req, res) => {
  try {
    const guides = await getAllGuidesForBackup();
    res.json({ exported_at: new Date().toISOString(), guides });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to export guides" });
  }
});

// Upserts by id, so restoring after a wipe brings guides back with their
// original ids intact (student_activity rows reference guide_id, so this
// matters). Never deletes anything not in the backup — a restore only ever
// adds/overwrites, so it's safe to run even if some guides already exist.
app.post("/api/admin/restore/guides", requireAdmin, async (req, res) => {
  const { guides } = req.body;
  if (!Array.isArray(guides)) return res.status(400).json({ error: "expected { guides: [...] }" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const g of guides) {
      if (!g.title || !g.slug) continue;
      await client.query(
        `INSERT INTO guides (id, title, slug, subject, section, body, published, author_id, author_username, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()), COALESCE($11, now()))
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title, slug = EXCLUDED.slug, subject = EXCLUDED.subject,
           section = EXCLUDED.section, body = EXCLUDED.body, published = EXCLUDED.published,
           author_id = EXCLUDED.author_id, author_username = EXCLUDED.author_username,
           updated_at = EXCLUDED.updated_at`,
        [g.id, g.title, g.slug, g.subject || null, g.section || null, g.body || "", g.published !== false,
         g.author_id || null, g.author_username || null, g.created_at || null, g.updated_at || null]
      );
    }
    await client.query(`SELECT setval('guides_id_seq', GREATEST((SELECT COALESCE(MAX(id), 1) FROM guides), 1))`);
    await client.query("COMMIT");
    res.json({ success: true, restored: guides.length });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "failed to restore guides" });
  } finally {
    client.release();
  }
});

app.get("/api/cron/backup-guides", async (req, res) => {
  const authHeader = req.headers["authorization"] || "";
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { GITHUB_TOKEN, GITHUB_BACKUP_REPO, GITHUB_BACKUP_BRANCH } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_BACKUP_REPO) {
    console.error("backup cron: missing GITHUB_TOKEN or GITHUB_BACKUP_REPO");
    return res.status(500).json({ error: "backup not configured" });
  }
  const branch = GITHUB_BACKUP_BRANCH || "main";
  try {
    const guides = await getAllGuidesForBackup();
    const payload = { exported_at: new Date().toISOString(), guides };
    const dateStr = new Date().toISOString().slice(0, 10);
    const path = `backups/guides-${dateStr}.json`;
    const apiUrl = `https://api.github.com/repos/${GITHUB_BACKUP_REPO}/contents/${path}`;
    const ghHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json"
    };

    // Look up the existing file's sha (if the cron already ran today) so
    // this updates it instead of failing with a conflict.
    let sha = null;
    const existing = await fetch(`${apiUrl}?ref=${branch}`, { headers: ghHeaders });
    if (existing.ok) {
      const existingData = await existing.json();
      sha = existingData.sha || null;
    }

    const content = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");
    const putRes = await fetch(apiUrl, {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Guides backup ${dateStr} (${guides.length} guides)`,
        content,
        branch,
        ...(sha ? { sha } : {})
      })
    });
    if (!putRes.ok) {
      const errBody = await putRes.text();
      console.error("backup cron: GitHub commit failed", putRes.status, errBody);
      return res.status(502).json({ error: "failed to commit backup to GitHub" });
    }
    res.json({ success: true, guides: guides.length, path });
  } catch (err) {
    console.error("backup cron failed:", err);
    res.status(500).json({ error: "backup failed" });
  }
});

/* ---------------------------------------------------------------- */
/* Staff                                                              */
/* ---------------------------------------------------------------- */

// Any signed-in user can check the staff list, so pages can show a star
// next to a staff member's name.
app.get("/api/staff", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT username FROM staff ORDER BY username ASC`);
    res.json(result.rows.map((r) => r.username));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load staff" });
  }
});

app.get("/api/admin/staff", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM staff ORDER BY added_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load staff" });
  }
});

app.post("/api/admin/staff", requireAdmin, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "username is required" });
  try {
    const result = await pool.query(
      `INSERT INTO staff (username) VALUES ($1) ON CONFLICT (username) DO NOTHING RETURNING *`,
      [username.toLowerCase().trim()]
    );
    res.json(result.rows[0] || { username: username.toLowerCase().trim() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to add staff" });
  }
});

app.delete("/api/admin/staff/:username", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM staff WHERE username = $1`, [req.params.username.toLowerCase()]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to remove staff" });
  }
});

app.get("/api/guides", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, subject, section, published, updated_at FROM guides WHERE published = true ORDER BY updated_at DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load guides" });
  }
});

app.get("/api/guides/*", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, slug, subject, section, body, published, updated_at FROM guides WHERE slug = $1 AND published = true`,
      [req.params[0]]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "guide not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load guide" });
  }
});

app.get("/api/editor/guides", requireEditor, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM guides ORDER BY updated_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load guides" });
  }
});

app.post("/api/editor/guides", requireEditor, async (req, res) => {
  const { title, subject, section, body, published, slug: requestedSlug } = req.body;
  if (!title) {
    return res.status(400).json({ error: "title is required" });
  }
  const baseSlug = requestedSlug ? sanitizeSlug(requestedSlug) : slugify(title);
  try {
    let slug = baseSlug || slugify(title);
    let attempt = 1;
    while (true) {
      const existing = await pool.query(`SELECT id FROM guides WHERE slug = $1`, [slug]);
      if (existing.rows.length === 0) break;
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
    }
    const result = await pool.query(
      `INSERT INTO guides (title, slug, subject, section, body, published, author_id, author_username)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [title, slug, subject || null, section || null, body || "", published !== false, req.editor.id, req.editor.username]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create guide" });
  }
});

app.put("/api/editor/guides/:id", requireEditor, async (req, res) => {
  const { title, subject, section, body, published, slug: requestedSlug } = req.body;
  try {
    let newSlug = null;
    if (requestedSlug) {
      const cleaned = sanitizeSlug(requestedSlug);
      if (cleaned) {
        const existing = await pool.query(`SELECT id FROM guides WHERE slug = $1 AND id != $2`, [cleaned, req.params.id]);
        if (existing.rows.length > 0) {
          return res.status(409).json({ error: "that permalink is already in use" });
        }
        newSlug = cleaned;
      }
    }
    const result = await pool.query(
      `UPDATE guides
       SET title = COALESCE($1, title),
           subject = $2,
           section = $3,
           body = COALESCE($4, body),
           published = COALESCE($5, published),
           slug = COALESCE($6, slug),
           updated_at = now()
       WHERE id = $7
       RETURNING *`,
      [title || null, subject || null, section || null, body, published, newSlug, req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "guide not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update guide" });
  }
});

app.delete("/api/editor/guides/:id", requireEditor, async (req, res) => {
  try {
    await pool.query(`DELETE FROM guides WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete guide" });
  }
});

/* ---------------------------------------------------------------- */
/* Student account features (Clerk-authenticated)                    */
/* ---------------------------------------------------------------- */

app.get("/api/me", requireAuth, async (req, res) => {
  res.json(req.user);
});

// Classes -------------------------------------------------------------

app.get("/api/classes", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM classes ORDER BY name ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load classes" });
  }
});

app.post("/api/admin/classes", requireAdmin, async (req, res) => {
  const { name, subject } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const result = await pool.query(
      `INSERT INTO classes (name, subject) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET subject = EXCLUDED.subject
       RETURNING *`,
      [name, subject || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create class" });
  }
});

app.delete("/api/admin/classes/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query(`DELETE FROM classes WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete class" });
  }
});

// Student's own class toggles, used to personalize the homepage.
app.get("/api/student/classes", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.name, c.subject,
              COALESCE(sc.enabled, true) AS enabled
       FROM classes c
       LEFT JOIN student_classes sc
         ON sc.class_id = c.id AND sc.student_id = $1
       ORDER BY c.name ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load student classes" });
  }
});

app.put("/api/student/classes/:classId", requireAuth, async (req, res) => {
  const { enabled } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO student_classes (student_id, class_id, enabled, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (student_id, class_id)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
       RETURNING *`,
      [req.user.id, req.params.classId, enabled !== false]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to update class toggle" });
  }
});

// Activity / "resume where you left off" -------------------------------

app.get("/api/student/activity/last", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT sa.id, sa.unit_label, sa.last_viewed_at,
              g.id AS guide_id, g.title AS guide_title, g.slug AS guide_slug, g.subject
       FROM student_activity sa
       JOIN guides g ON g.id = sa.guide_id
       WHERE sa.student_id = $1
       ORDER BY sa.last_viewed_at DESC
       LIMIT 1`,
      [req.user.id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load last activity" });
  }
});

app.post("/api/student/activity", requireAuth, async (req, res) => {
  const { guideId, unitLabel } = req.body;
  if (!guideId) return res.status(400).json({ error: "guideId is required" });
  try {
    const result = await pool.query(
      `INSERT INTO student_activity (student_id, guide_id, unit_label, last_viewed_at)
       VALUES ($1, $2, $3, now())
       RETURNING *`,
      [req.user.id, guideId, unitLabel || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to record activity" });
  }
});

// Recommendations --------------------------------------------------------
// Simple personalization: prefer published guides in subjects the student
// has enabled classes for, that they haven't already viewed, newest first.
app.get("/api/student/recommended", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `WITH enabled_subjects AS (
         SELECT c.subject
         FROM student_classes sc
         JOIN classes c ON c.id = sc.class_id
         WHERE sc.student_id = $1 AND sc.enabled = true AND c.subject IS NOT NULL
       )
       SELECT g.id, g.title, g.slug, g.subject, g.author_username, g.updated_at
       FROM guides g
       WHERE g.published = true
         AND g.id NOT IN (
           SELECT guide_id FROM student_activity WHERE student_id = $1
         )
         AND (
           g.subject IN (SELECT subject FROM enabled_subjects)
           OR NOT EXISTS (SELECT 1 FROM enabled_subjects)
         )
       ORDER BY g.updated_at DESC
       LIMIT 1`,
      [req.user.id]
    );
    let guide = result.rows[0];
    if (!guide) {
      const fallback = await pool.query(
        `SELECT id, title, slug, subject, author_username, updated_at
         FROM guides WHERE published = true ORDER BY updated_at DESC LIMIT 1`
      );
      guide = fallback.rows[0] || null;
    }

    // Same idea for the archive: prefer an approved item tagged with a class
    // the student has enabled, falling back to the newest approved item.
    const archiveResult = await pool.query(
      `SELECT a.id, a.title, a.filename, a.mime_type, a.class_id, c.name AS class_name, a.uploader_username, a.uploaded_at
       FROM archive_items a
       LEFT JOIN classes c ON c.id = a.class_id
       WHERE a.status = 'approved'
         AND (
           a.class_id IN (
             SELECT class_id FROM student_classes WHERE student_id = $1 AND enabled = true
           )
           OR NOT EXISTS (
             SELECT 1 FROM student_classes WHERE student_id = $1 AND enabled = true
           )
         )
       ORDER BY a.uploaded_at DESC
       LIMIT 1`,
      [req.user.id]
    );
    let archiveItem = archiveResult.rows[0];
    if (!archiveItem) {
      const archiveFallback = await pool.query(
        `SELECT a.id, a.title, a.filename, a.mime_type, a.class_id, c.name AS class_name, a.uploader_username, a.uploaded_at
         FROM archive_items a LEFT JOIN classes c ON c.id = a.class_id
         WHERE a.status = 'approved' ORDER BY a.uploaded_at DESC LIMIT 1`
      );
      archiveItem = archiveFallback.rows[0] || null;
    }

    res.json({ guide: guide || null, archiveItem: archiveItem || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load recommendation" });
  }
});

/* ---------------------------------------------------------------- */
/* Archive                                                            */
/* ---------------------------------------------------------------- */
// Anyone signed in can upload. Staff uploads are auto-approved; everyone
// else's land as "pending" until a staff member reviews them. Uploaders can
// pick a class up front, or leave it blank and have staff tag it on review.

async function isStaffUsername(username) {
  if (!username) return false;
  const check = await pool.query(`SELECT 1 FROM staff WHERE username = $1`, [username.toLowerCase()]);
  return check.rows.length > 0;
}

const ARCHIVE_ITEM_COLUMNS = `
  id, title, filename, mime_type, class_id, uploader_id, uploader_username,
  status, rejection_reason, reviewed_by, reviewed_at, uploaded_at
`;

app.post("/api/archive", requireAuth, async (req, res) => {
  const { title, filename, mimeType, fileData, classId } = req.body;
  if (!title || !filename || !fileData) {
    return res.status(400).json({ error: "title, filename, and fileData are required" });
  }
  try {
    const staff = await isStaffUsername(req.user.username);
    const status = staff ? "approved" : "pending";
    const result = await pool.query(
      `INSERT INTO archive_items
         (title, filename, mime_type, file_data, class_id, uploader_id, uploader_username, status, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${ARCHIVE_ITEM_COLUMNS}`,
      [
        title, filename, mimeType || null, fileData, classId || null,
        req.user.id, req.user.username || req.user.name, status,
        staff ? req.user.username : null, staff ? new Date() : null
      ]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to upload" });
  }
});

// Public/approved feed, optionally filtered by class. File bytes are
// excluded here on purpose — this can be a long list, and base64 blobs
// would make it huge. Fetch /api/archive/:id for the actual file.
app.get("/api/archive", async (req, res) => {
  try {
    const { classId } = req.query;
    const result = await pool.query(
      `SELECT ${ARCHIVE_ITEM_COLUMNS}
       FROM archive_items
       WHERE status = 'approved' ${classId ? "AND class_id = $1" : ""}
       ORDER BY uploaded_at DESC`,
      classId ? [classId] : []
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load archive" });
  }
});

// The signed-in user's own uploads, any status, so they can track progress.
app.get("/api/archive/mine", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${ARCHIVE_ITEM_COLUMNS}
       FROM archive_items WHERE uploader_id = $1 ORDER BY uploaded_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load your uploads" });
  }
});

// Staff-only review queue.
app.get("/api/archive/pending", requireEditor, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ${ARCHIVE_ITEM_COLUMNS}
       FROM archive_items WHERE status = 'pending' ORDER BY uploaded_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load pending uploads" });
  }
});

// Approve or reject a pending upload. Staff can set/override the class here
// too — useful when the uploader left it blank.
app.patch("/api/archive/:id/review", requireEditor, async (req, res) => {
  const { status, classId, rejectionReason } = req.body;
  if (!["approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "status must be approved or rejected" });
  }
  try {
    const result = await pool.query(
      `UPDATE archive_items
       SET status = $1, class_id = COALESCE($2, class_id),
           rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
       WHERE id = $5
       RETURNING ${ARCHIVE_ITEM_COLUMNS}`,
      [status, classId || null, status === "rejected" ? (rejectionReason || null) : null, req.editor.username, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: "not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to review upload" });
  }
});

// Fetches the actual file. Approved items are viewable by any signed-in
// user; a pending/rejected item is only visible to its uploader or staff.
app.get("/api/archive/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM archive_items WHERE id = $1`, [req.params.id]);
    const item = result.rows[0];
    if (!item) return res.status(404).json({ error: "not found" });
    if (item.status !== "approved" && item.uploader_id !== req.user.id && !(await isStaffUsername(req.user.username))) {
      return res.status(403).json({ error: "not authorized" });
    }
    res.json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load item" });
  }
});

// Uploader can pull their own (e.g. rejected) item; staff can remove anything.
app.delete("/api/archive/:id", requireAuth, async (req, res) => {
  try {
    const existing = await pool.query(`SELECT uploader_id FROM archive_items WHERE id = $1`, [req.params.id]);
    if (!existing.rows.length) return res.status(404).json({ error: "not found" });
    const owns = existing.rows[0].uploader_id === req.user.id;
    if (!owns && !(await isStaffUsername(req.user.username))) {
      return res.status(403).json({ error: "not authorized" });
    }
    await pool.query(`DELETE FROM archive_items WHERE id = $1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to delete item" });
  }
});

/* ---------------------------------------------------------------- */
/* Games                                                              */
/* ---------------------------------------------------------------- */

app.get("/api/games", async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM games ORDER BY title ASC`);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load games" });
  }
});

app.post("/api/admin/games", requireAdmin, async (req, res) => {
  const { title, subject } = req.body;
  if (!title) return res.status(400).json({ error: "title is required" });
  const slug = slugify(title);
  try {
    const result = await pool.query(
      `INSERT INTO games (title, slug, subject) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, subject = EXCLUDED.subject
       RETURNING *`,
      [title, slug, subject || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to create game" });
  }
});

app.get("/api/games/:slug/leaderboard", async (req, res) => {
  try {
    const game = await pool.query(`SELECT * FROM games WHERE slug = $1`, [req.params.slug]);
    if (game.rows.length === 0) return res.status(404).json({ error: "game not found" });
    const result = await pool.query(
      `SELECT DISTINCT ON (student_id) student_id, student_name, score, played_at
       FROM game_results
       WHERE game_id = $1
       ORDER BY student_id, score DESC
       LIMIT 50`,
      [game.rows[0].id]
    );
    const ranked = result.rows.sort((a, b) => b.score - a.score).slice(0, 10);
    res.json({ game: game.rows[0], leaderboard: ranked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load leaderboard" });
  }
});

app.post("/api/games/:slug/results", requireAuth, async (req, res) => {
  const { score } = req.body;
  if (typeof score !== "number") return res.status(400).json({ error: "score is required" });
  try {
    const game = await pool.query(`SELECT * FROM games WHERE slug = $1`, [req.params.slug]);
    if (game.rows.length === 0) return res.status(404).json({ error: "game not found" });
    const result = await pool.query(
      `INSERT INTO game_results (game_id, student_id, student_name, score)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [game.rows[0].id, req.user.id, req.user.name, score]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to save result" });
  }
});

// Most recently played game for this student, with its leaderboard —
// powers the "Recently played minigames" homepage card.
app.get("/api/student/games/recent", requireAuth, async (req, res) => {
  try {
    const recent = await pool.query(
      `SELECT g.id, g.title, g.slug, g.subject, MAX(gr.played_at) AS last_played_at
       FROM game_results gr
       JOIN games g ON g.id = gr.game_id
       WHERE gr.student_id = $1
       GROUP BY g.id
       ORDER BY last_played_at DESC
       LIMIT 1`,
      [req.user.id]
    );
    if (recent.rows.length === 0) return res.json(null);
    const game = recent.rows[0];
    const leaderboard = await pool.query(
      `SELECT DISTINCT ON (student_id) student_id, student_name, score
       FROM game_results
       WHERE game_id = $1
       ORDER BY student_id, score DESC`,
      [game.id]
    );
    const ranked = leaderboard.rows.sort((a, b) => b.score - a.score).slice(0, 5);
    res.json({ game, leaderboard: ranked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "failed to load recent game" });
  }
});

export default app;
