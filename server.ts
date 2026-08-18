import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import { Pool, types } from 'pg';
import bcrypt from 'bcryptjs';
import path from 'path';
import nodemailer from 'nodemailer';
import cron from 'node-cron';

// Return timestamps as strings so existing .split('T') logic works
types.setTypeParser(1114, (val: string) => val); // TIMESTAMP WITHOUT TIME ZONE
types.setTypeParser(1184, (val: string) => val); // TIMESTAMP WITH TIME ZONE
// Return bigint (COUNT/SUM) as JS number
types.setTypeParser(20, (val: string) => parseInt(val, 10));
// Return numeric (AVG/ROUND) as JS float
types.setTypeParser(1700, (val: string) => parseFloat(val));

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql: string, params: any[] = []) {
  const res = await pool.query(sql, params);
  return res;
}

// ── Schema ──────────────────────────────────────────────────────────────────

async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('manager','employee')),
      avatar_initials TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      job_title TEXT,
      department TEXT,
      joined_at TEXT,
      last_promotion_date TEXT,
      promotion_title TEXT,
      bio TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS goals (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL CHECK(type IN ('team','individual')),
      assigned_to INTEGER REFERENCES users(id),
      progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','completed')),
      due_date TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      reminder_sent INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS updates (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS highlights (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('employee_month','activity_month','shoutout')),
      title TEXT NOT NULL,
      description TEXT,
      employee_id INTEGER REFERENCES users(id),
      month TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS awards (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      title TEXT NOT NULL,
      description TEXT,
      awarded_at TEXT NOT NULL,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS goal_comments (
      id SERIAL PRIMARY KEY,
      goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS evaluations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      year INTEGER NOT NULL,
      period TEXT NOT NULL DEFAULT 'Annual',
      eval_type TEXT,
      tl_name TEXT,
      type_of_work TEXT,
      x_factor TEXT,
      problem_solving REAL,
      project_scoping REAL,
      communication REAL,
      attention_to_detail REAL,
      attitude_towards_work REAL,
      compliance REAL,
      client_management REAL,
      feedback_360 REAL,
      piex_internal REAL,
      engagement REAL,
      complexity_of_work REAL,
      avg_feedback_rating REAL,
      learning_curve REAL,
      area_of_improvement TEXT,
      net_rating REAL,
      comments TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, year, period)
    );

    CREATE TABLE IF NOT EXISTS user_skills (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, skill)
    );

    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS polls (
      id SERIAL PRIMARY KEY,
      question TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id),
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS poll_responses (
      id SERIAL PRIMARY KEY,
      poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id),
      response TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(poll_id, user_id)
    );
  `);

  // Migrations: add columns if not present (for existing PostgreSQL databases)
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS joined_at TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_promotion_date TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS promotion_title TEXT`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
  await query(`ALTER TABLE goals ADD COLUMN IF NOT EXISTS reminder_sent INTEGER NOT NULL DEFAULT 0`);
  await query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS eval_type TEXT`);
  await query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS complexity_of_work REAL`);
  await query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS avg_feedback_rating REAL`);
  await query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS learning_curve REAL`);
  await query(`ALTER TABLE evaluations ADD COLUMN IF NOT EXISTS area_of_improvement TEXT`);
  // Ensure alice is admin
  await query(`UPDATE users SET is_admin=1 WHERE email='alice@company.com' AND is_admin=0`);
}

// ── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  const countRow = (await query('SELECT COUNT(*) as c FROM users')).rows[0];
  const count = countRow.c;
  if (count > 0) {
    // patch existing seed users with profile data if missing
    await query(`UPDATE users SET job_title='Engineering Manager', department='Engineering',
      joined_at='2021-03-01', last_promotion_date='2023-06-01', promotion_title='Senior Engineering Manager',
      bio='Leads the core product engineering team. Passionate about developer productivity and team culture.'
      WHERE email='alice@company.com' AND job_title IS NULL`);
    await query(`UPDATE users SET job_title='Product Manager', department='Product',
      joined_at='2020-08-15', last_promotion_date='2022-11-01', promotion_title='Senior Product Manager',
      bio='Drives product strategy and roadmap. Previously at two SaaS startups.'
      WHERE email='frank@company.com' AND job_title IS NULL`);
    await query(`UPDATE users SET job_title='Software Engineer', department='Engineering',
      joined_at='2022-01-10', last_promotion_date='2024-01-15', promotion_title='Software Engineer II',
      bio='Full-stack engineer focused on backend systems and infrastructure.'
      WHERE email='bob@company.com' AND job_title IS NULL`);
    await query(`UPDATE users SET job_title='UX Designer', department='Design',
      joined_at='2021-09-20', last_promotion_date='2023-09-01', promotion_title='Senior UX Designer',
      bio='Designs intuitive user experiences. Led the redesign of the core dashboard.'
      WHERE email='carol@company.com' AND job_title IS NULL`);
    await query(`UPDATE users SET job_title='Data Analyst', department='Analytics',
      joined_at='2023-03-06',
      bio='Builds data pipelines and dashboards for business intelligence.'
      WHERE email='dave@company.com' AND job_title IS NULL`);
    await query(`UPDATE users SET job_title='Marketing Specialist', department='Marketing',
      joined_at='2022-06-01', last_promotion_date='2024-06-01', promotion_title='Marketing Lead',
      bio='Runs growth campaigns and manages social media presence.'
      WHERE email='eve@company.com' AND job_title IS NULL`);
    return;
  }

  const hash = (p: string) => bcrypt.hashSync(p, 10);

  await query(
    `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio,is_admin)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    ['Alice Manager','alice@company.com',hash('password123'),'manager','AM',
     'Engineering Manager','Engineering','2021-03-01','2023-06-01','Senior Engineering Manager',
     'Leads the core product engineering team. Passionate about developer productivity and team culture.',1]
  );
  await query(
    `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ['Frank Manager','frank@company.com',hash('password123'),'manager','FM',
     'Product Manager','Product','2020-08-15','2022-11-01','Senior Product Manager',
     'Drives product strategy and roadmap. Previously at two SaaS startups.']
  );
  await query(
    `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ['Bob Employee','bob@company.com',hash('password123'),'employee','BE',
     'Software Engineer','Engineering','2022-01-10','2024-01-15','Software Engineer II',
     'Full-stack engineer focused on backend systems and infrastructure.']
  );
  await query(
    `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ['Carol Employee','carol@company.com',hash('password123'),'employee','CE',
     'UX Designer','Design','2021-09-20','2023-09-01','Senior UX Designer',
     'Designs intuitive user experiences. Led the redesign of the core dashboard.']
  );
  await query(
    `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ['Dave Employee','dave@company.com',hash('password123'),'employee','DE',
     'Data Analyst','Analytics','2023-03-06',null,null,
     'Builds data pipelines and dashboards for business intelligence.']
  );
  await query(
    `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    ['Eve Employee','eve@company.com',hash('password123'),'employee','EE',
     'Marketing Specialist','Marketing','2022-06-01','2024-06-01','Marketing Lead',
     'Runs growth campaigns and manages social media presence.']
  );

  const alice = (await query("SELECT id FROM users WHERE email='alice@company.com'")).rows[0].id;
  const bob   = (await query("SELECT id FROM users WHERE email='bob@company.com'")).rows[0].id;
  const carol = (await query("SELECT id FROM users WHERE email='carol@company.com'")).rows[0].id;
  const dave  = (await query("SELECT id FROM users WHERE email='dave@company.com'")).rows[0].id;

  await query(
    `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['Launch Q2 Product Update','Ship all Q2 milestones on schedule','team',null,65,'in_progress','2026-06-30',alice]
  );
  await query(
    `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['Improve Customer NPS to 70','Increase NPS score from 58 to 70','team',null,30,'in_progress','2026-12-31',alice]
  );
  await query(
    `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['Complete AWS Certification','Pass AWS Solutions Architect exam','individual',bob,80,'in_progress','2026-05-31',alice]
  );
  await query(
    `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['Lead Onboarding for 3 New Hires','Mentor and onboard Q2 joiners','individual',carol,100,'completed','2026-04-15',alice]
  );
  await query(
    `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['Build Q2 Analytics Dashboard','Deliver self-serve BI dashboard for all teams','individual',dave,45,'in_progress','2026-06-15',alice]
  );

  await query(
    `INSERT INTO updates (title,content,created_by) VALUES ($1,$2,$3)`,
    ['Welcome to Team Dashboard!','This is our new central hub for team goals, updates, and highlights. Check back regularly for the latest news.',alice]
  );
  await query(
    `INSERT INTO updates (title,content,created_by) VALUES ($1,$2,$3)`,
    ['Q2 Planning Wrap-up','We have finalized our Q2 goals. All individual goals have been assigned — check your Goals tab.',alice]
  );

  await query(
    `INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['employee_month','Employee of the Month: Carol','Carol successfully led the onboarding of 3 new hires ahead of schedule. Exceptional initiative!',carol,'2026-04',alice]
  );
  await query(
    `INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['activity_month','Activity of the Month: Team Hackathon','Our April hackathon produced 4 prototypes — two are moving to production.',null,'2026-04',alice]
  );
  await query(
    `INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    ['shoutout','Shoutout: Bob','Bob went above and beyond helping the infra team during the on-call rotation. Thank you!',bob,'2026-04',alice]
  );

  await query(
    `INSERT INTO awards (user_id,title,description,awarded_at,created_by) VALUES ($1,$2,$3,$4,$5)`,
    [carol,'Best Team Player — Q1 2026','Recognized for outstanding collaboration and mentorship across the design and engineering teams.','2026-03-31',alice]
  );
  await query(
    `INSERT INTO awards (user_id,title,description,awarded_at,created_by) VALUES ($1,$2,$3,$4,$5)`,
    [bob,'Innovation Award 2025','Delivered a performance optimization that reduced API latency by 40%.','2025-12-15',alice]
  );
  await query(
    `INSERT INTO awards (user_id,title,description,awarded_at,created_by) VALUES ($1,$2,$3,$4,$5)`,
    [carol,'Onboarding Champion','Led onboarding for 3 new hires with perfect satisfaction scores.','2026-04-15',alice]
  );
}

// ── Email ─────────────────────────────────────────────────────────────────────

let mailer: nodemailer.Transporter | null = null;

async function setupMailer() {
  const account = await nodemailer.createTestAccount();
  mailer = nodemailer.createTransport({
    host: 'smtp.ethereal.email', port: 587, secure: false,
    auth: { user: account.user, pass: account.pass },
  });
  console.log('📧 Test email inbox:', account.web);
}

async function sendEmail(to: string, subject: string, html: string) {
  if (!mailer) return;
  try {
    const info = await mailer.sendMail({
      from: '"Team Dashboard" <noreply@teamdashboard.app>',
      to, subject, html,
    });
    console.log('Email sent:', nodemailer.getTestMessageUrl(info));
  } catch (e) { console.error('Email error:', e); }
}

// ── Middleware ───────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'team-dashboard-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}) as any);

declare module 'express-session' {
  interface SessionData { userId: number; role: string; isAdmin: boolean; }
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function requireManager(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (req.session.role !== 'manager' && !req.session.isAdmin) return res.status(403).json({ error: 'Managers only' });
  next();
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Admins only' });
  next();
}

// ── Auth ─────────────────────────────────────────────────────────────────────

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = (await query('SELECT * FROM users WHERE email=$1', [email])).rows[0];
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Invalid credentials' });
    req.session.userId = user.id;
    req.session.role = user.role;
    req.session.isAdmin = !!user.is_admin;
    res.json({ id: user.id, name: user.name, email: user.email, role: user.role, is_admin: !!user.is_admin, avatar_initials: user.avatar_initials });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, role, job_title, department } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
    if (!email.toLowerCase().endsWith('@penguin-international.com')) return res.status(400).json({ error: 'Only @penguin-international.com email addresses are allowed' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const existing = (await query('SELECT id FROM users WHERE email=$1', [email])).rows[0];
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
    const initials = name.trim().split(/\s+/).map((w: string) => w[0].toUpperCase()).slice(0, 2).join('');
    const insertResult = await query(
      `INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE) RETURNING id`,
      [name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), 'employee', initials, job_title || null, department || null]
    );
    const newId = insertResult.rows[0].id;
    const user = (await query('SELECT id,name,email,role,avatar_initials FROM users WHERE id=$1', [newId])).rows[0];
    req.session.userId = user.id;
    req.session.role = user.role;
    res.status(201).json(user);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const u = (await query('SELECT id,name,email,role,is_admin,avatar_initials FROM users WHERE id=$1', [req.session.userId])).rows[0];
    res.json({ ...u, is_admin: !!u.is_admin });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Users (simple list for dropdowns) ────────────────────────────────────────

app.get('/api/users', requireAuth, async (req, res) => {
  try {
    res.json((await query('SELECT id,name,email,role,avatar_initials FROM users ORDER BY name')).rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Members (full profiles) ───────────────────────────────────────────────────

app.get('/api/members', requireAuth, async (req, res) => {
  try {
    const members = (await query(`
      SELECT id, name, email, role, avatar_initials, job_title, department,
             joined_at, last_promotion_date, promotion_title, bio
      FROM users WHERE id != $1 ORDER BY name
    `, [req.session.userId])).rows as any[];

    for (const m of members) {
      const gc = (await query(`SELECT COUNT(*) as total,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done,
        ROUND(AVG(progress::numeric),0) as avg
        FROM goals WHERE assigned_to=$1`, [m.id])).rows[0];
      m.goal_total = gc.total;
      m.goal_done = gc.done || 0;
      m.goal_avg_progress = gc.avg || 0;
      const aw = (await query(`SELECT COUNT(*) as c FROM awards WHERE user_id=$1`, [m.id])).rows[0];
      m.award_count = aw.c;
    }
    res.json(members);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/members/:id', requireAuth, async (req, res) => {
  try {
    const member = (await query(`
      SELECT id, name, email, role, avatar_initials, job_title, department,
             joined_at, last_promotion_date, promotion_title, bio
      FROM users WHERE id=$1
    `, [req.params.id])).rows[0] as any;
    if (!member) return res.status(404).json({ error: 'Not found' });

    member.goals = (await query(`
      SELECT g.*, u.name as creator_name FROM goals g
      LEFT JOIN users u ON g.created_by = u.id
      WHERE g.assigned_to=$1 ORDER BY g.created_at DESC
    `, [req.params.id])).rows;

    member.awards = (await query(`
      SELECT a.*, u.name as given_by FROM awards a
      LEFT JOIN users u ON a.created_by = u.id
      WHERE a.user_id=$1 ORDER BY a.awarded_at DESC
    `, [req.params.id])).rows;

    member.highlights = (await query(`
      SELECT h.*, u.name as creator_name FROM highlights h
      LEFT JOIN users u ON h.created_by = u.id
      WHERE h.employee_id=$1 ORDER BY h.month DESC
    `, [req.params.id])).rows;

    res.json(member);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/members/:id', requireManager, async (req, res) => {
  try {
    const { job_title, department, joined_at, last_promotion_date, promotion_title, bio, name } = req.body;
    await query(`UPDATE users SET
      name=COALESCE($1,name), job_title=COALESCE($2,job_title), department=COALESCE($3,department),
      joined_at=COALESCE($4,joined_at), last_promotion_date=COALESCE($5,last_promotion_date),
      promotion_title=COALESCE($6,promotion_title), bio=COALESCE($7,bio)
      WHERE id=$8`,
      [name, job_title, department, joined_at, last_promotion_date, promotion_title, bio, req.params.id]
    );
    res.json((await query(
      'SELECT id,name,email,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio FROM users WHERE id=$1',
      [req.params.id]
    )).rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Awards ────────────────────────────────────────────────────────────────────

app.post('/api/members/:id/awards', requireManager, async (req, res) => {
  try {
    const { title, description, awarded_at } = req.body;
    if (!title || !awarded_at) return res.status(400).json({ error: 'title and awarded_at required' });
    const result = (await query(
      `INSERT INTO awards (user_id,title,description,awarded_at,created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.id, title, description || null, awarded_at, req.session.userId]
    )).rows[0];
    res.status(201).json(result);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Admin: delete a team member and all their data
app.delete('/api/members/:id', requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (targetId === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
    const user = (await query('SELECT id, name FROM users WHERE id=$1', [targetId])).rows[0] as any;
    if (!user) return res.status(404).json({ error: 'User not found' });

    await pool.query('BEGIN');
    try {
      await query('DELETE FROM user_skills WHERE user_id=$1', [targetId]);
      await query('DELETE FROM evaluations WHERE user_id=$1 OR created_by=$2', [targetId, targetId]);
      await query('DELETE FROM awards WHERE user_id=$1 OR created_by=$2', [targetId, targetId]);
      await query('DELETE FROM goal_comments WHERE user_id=$1', [targetId]);
      await query('DELETE FROM goals WHERE created_by=$1', [targetId]);
      await query('UPDATE goals SET assigned_to=NULL WHERE assigned_to=$1', [targetId]);
      await query('DELETE FROM updates WHERE created_by=$1', [targetId]);
      await query('DELETE FROM highlights WHERE created_by=$1', [targetId]);
      await query('UPDATE highlights SET employee_id=NULL WHERE employee_id=$1', [targetId]);
      await query('DELETE FROM users WHERE id=$1', [targetId]);
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.json({ ok: true, deleted: user.name });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/awards/:id', requireManager, async (req, res) => {
  try {
    const result = await query('DELETE FROM awards WHERE id=$1', [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Goals ─────────────────────────────────────────────────────────────────────

app.get('/api/goals', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const role = req.session.role;
    const { type } = req.query;
    let sql = `SELECT g.*, u.name as assigned_name, u.avatar_initials, m.name as creator_name,
      (SELECT COUNT(*) FROM goal_comments c WHERE c.goal_id = g.id) as comment_count
      FROM goals g LEFT JOIN users u ON g.assigned_to = u.id LEFT JOIN users m ON g.created_by = m.id`;
    const conditions: string[] = [];
    const params: any[] = [];
    if (role === 'employee') {
      conditions.push(`g.assigned_to = $${params.length + 1}`); params.push(userId);
    } else {
      conditions.push("(g.type = 'team' OR g.assigned_to IS NULL OR u.role = 'employee')");
    }
    if (type === 'team') conditions.push("g.type = 'team'");
    if (type === 'individual') conditions.push("g.type = 'individual'");
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY g.created_at DESC';
    res.json((await query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Personal goals — only visible to the current user (any role)
app.get('/api/my-goals', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const goals = (await query(`SELECT g.*, u.name as assigned_name, u.avatar_initials,
      (SELECT COUNT(*) FROM goal_comments c WHERE c.goal_id = g.id) as comment_count
      FROM goals g LEFT JOIN users u ON g.assigned_to = u.id
      WHERE g.assigned_to = $1 ORDER BY g.created_at DESC`, [userId])).rows;
    res.json(goals);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/my-goals', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const { title, description, progress, status, due_date } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = await query(
      `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [title, description || null, 'individual', userId, progress || 0, status || 'not_started', due_date || null, userId]
    );
    const newId = result.rows[0].id;
    res.status(201).json((await query('SELECT * FROM goals WHERE id=$1', [newId])).rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Goals Export (must be before /:id) ───────────────────────────────────────

app.get('/api/goals/export', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const role = req.session.role;
    let goals: any[];
    if (role === 'manager') {
      goals = (await query(`SELECT g.title, g.type, u.name as assigned_to, g.status, g.progress, g.due_date, g.description, g.created_at
        FROM goals g LEFT JOIN users u ON g.assigned_to = u.id
        WHERE (g.type = 'team' OR g.assigned_to IS NULL OR u.role = 'employee')
        ORDER BY g.type, u.name, g.created_at`)).rows;
    } else {
      goals = (await query(`SELECT g.title, g.type, u.name as assigned_to, g.status, g.progress, g.due_date, g.description, g.created_at
        FROM goals g LEFT JOIN users u ON g.assigned_to = u.id
        WHERE g.assigned_to = $1 ORDER BY g.created_at`, [userId])).rows;
    }

    const escape = (v: any) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Title', 'Type', 'Assigned To', 'Status', 'Progress %', 'Due Date', 'Description', 'Created At'];
    const rows = goals.map(g => [
      escape(g.title), escape(g.type), escape(g.assigned_to), escape(g.status),
      g.progress, escape(g.due_date), escape(g.description), escape(g.created_at?.split('T')[0])
    ].join(','));
    const csv = [header.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="goals-export.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/my-goals/export', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const goals = (await query(`SELECT g.title, g.status, g.progress, g.due_date, g.description, g.created_at
      FROM goals g WHERE g.assigned_to = $1 ORDER BY g.created_at`, [userId])).rows;

    const escape = (v: any) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Title', 'Status', 'Progress %', 'Due Date', 'Description', 'Created At'];
    const rows = goals.map((g: any) => [
      escape(g.title), escape(g.status), g.progress,
      escape(g.due_date), escape(g.description), escape(g.created_at?.split('T')[0])
    ].join(','));
    const csv = [header.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="my-goals-export.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/goals/bulk', requireManager, async (req, res) => {
  try {
    const { goals } = req.body;
    if (!Array.isArray(goals) || goals.length === 0) return res.status(400).json({ error: 'goals array required' });
    const results: any[] = [];
    const errors: string[] = [];

    await pool.query('BEGIN');
    try {
      for (let i = 0; i < goals.length; i++) {
        const g = goals[i];
        if (!g.title || !g.type) { errors.push(`Row ${i + 1}: title and type are required`); continue; }
        if (!['team', 'individual'].includes(g.type)) { errors.push(`Row ${i + 1}: type must be "team" or "individual"`); continue; }

        let assignedId: number | null = null;
        if (g.assigned_to) {
          assignedId = parseInt(g.assigned_to) || null;
        } else if (g.assigned_email) {
          const u = (await query('SELECT id FROM users WHERE email=$1', [g.assigned_email.trim().toLowerCase()])).rows[0];
          if (!u) { errors.push(`Row ${i + 1}: no user found with email "${g.assigned_email}"`); continue; }
          assignedId = u.id;
        }
        const progress = Math.min(100, Math.max(0, parseInt(g.progress) || 0));
        const status = ['not_started', 'in_progress', 'completed'].includes(g.status) ? g.status : 'not_started';
        const r = await query(
          `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [g.title.trim(), g.description || null, g.type, assignedId, progress, status, g.due_date || null, req.session.userId]
        );
        results.push({ id: r.rows[0].id, title: g.title });
      }
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.status(201).json({ inserted: results.length, errors });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/goals', requireManager, async (req, res) => {
  try {
    const { title, description, type, assigned_to, progress, status, due_date } = req.body;
    if (!title || !type) return res.status(400).json({ error: 'title and type required' });
    const result = await query(
      `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [title, description || null, type, assigned_to || null, progress || 0, status || 'not_started', due_date || null, req.session.userId]
    );
    const newId = result.rows[0].id;
    res.status(201).json((await query('SELECT * FROM goals WHERE id=$1', [newId])).rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/goals/:id', requireAuth, async (req, res) => {
  try {
    const goal = (await query('SELECT * FROM goals WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!goal) return res.status(404).json({ error: 'Not found' });
    const isManager = req.session.role === 'manager';
    const isAssignee = goal.assigned_to === req.session.userId;
    if (!isManager && !isAssignee) return res.status(403).json({ error: 'Forbidden' });
    const { title, description, type, assigned_to, progress, status, due_date } = req.body;
    const wasCompleted = goal.status === 'completed';
    if (isManager) {
      await query(`UPDATE goals SET title=COALESCE($1,title), description=COALESCE($2,description),
        type=COALESCE($3,type), assigned_to=$4, progress=COALESCE($5,progress),
        status=COALESCE($6,status), due_date=COALESCE($7,due_date), updated_at=NOW() WHERE id=$8`,
        [title, description, type, assigned_to !== undefined ? assigned_to : goal.assigned_to, progress, status, due_date, req.params.id]
      );
    } else {
      await query(`UPDATE goals SET title=COALESCE($1,title), description=COALESCE($2,description),
        progress=COALESCE($3,progress), status=COALESCE($4,status), due_date=COALESCE($5,due_date),
        updated_at=NOW() WHERE id=$6`,
        [title, description, progress, status, due_date, req.params.id]
      );
    }
    const updated = (await query('SELECT * FROM goals WHERE id=$1', [req.params.id])).rows[0] as any;

    // Notify managers when a goal is marked complete
    if (!wasCompleted && updated.status === 'completed') {
      const assignee = updated.assigned_to
        ? (await query('SELECT name FROM users WHERE id=$1', [updated.assigned_to])).rows[0]
        : null;
      const managers = (await query("SELECT email, name FROM users WHERE role='manager'")).rows as any[];
      for (const mgr of managers) {
        sendEmail(mgr.email, `✅ Goal Completed: ${updated.title}`,
          `<p>Hi ${mgr.name},</p>
           <p><strong>${assignee?.name || 'Someone'}</strong> just marked the goal <strong>"${updated.title}"</strong> as <strong>completed</strong>.</p>
           <p>Progress: ${updated.progress}%</p>
           <p><a href="http://localhost:3001">View Dashboard →</a></p>`
        );
      }
      if (updated.assigned_to && updated.assigned_to !== req.session.userId) {
        const assigneeUser = (await query('SELECT email, name FROM users WHERE id=$1', [updated.assigned_to])).rows[0] as any;
        if (assigneeUser) {
          sendEmail(assigneeUser.email, `🎉 Goal Completed: ${updated.title}`,
            `<p>Hi ${assigneeUser.name},</p>
             <p>Your goal <strong>"${updated.title}"</strong> has been marked as <strong>completed</strong>. Great work!</p>`
          );
        }
      }
    }

    res.json(updated);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/goals/:id', requireAuth, async (req, res) => {
  try {
    const goal = (await query('SELECT * FROM goals WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!goal) return res.status(404).json({ error: 'Not found' });
    const isManager = req.session.role === 'manager';
    const isAssignee = goal.assigned_to === req.session.userId;
    if (!isManager && !isAssignee) return res.status(403).json({ error: 'Forbidden' });
    await query('DELETE FROM goals WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const role = req.session.role;
    const teamGoals = (await query(`SELECT COUNT(*) as c FROM goals WHERE type='team'`)).rows[0].c;
    const teamCompleted = (await query(`SELECT COUNT(*) as c FROM goals WHERE type='team' AND status='completed'`)).rows[0].c;
    const avgProgress = (await query(`SELECT ROUND(AVG(progress::numeric),1) as avg FROM goals WHERE type='team'`)).rows[0].avg || 0;
    let myGoals = null, myCompleted = null;
    if (role === 'employee') {
      myGoals = (await query(`SELECT COUNT(*) as c FROM goals WHERE assigned_to=$1`, [userId])).rows[0].c;
      myCompleted = (await query(`SELECT COUNT(*) as c FROM goals WHERE assigned_to=$1 AND status='completed'`, [userId])).rows[0].c;
    }
    res.json({
      teamGoals, teamCompleted, teamAvgProgress: avgProgress,
      myGoals, myCompleted,
      totalUpdates: (await query(`SELECT COUNT(*) as c FROM updates`)).rows[0].c,
      totalHighlights: (await query(`SELECT COUNT(*) as c FROM highlights`)).rows[0].c,
    });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Updates ───────────────────────────────────────────────────────────────────

app.get('/api/updates', requireAuth, async (req, res) => {
  try {
    res.json((await query(`SELECT u.*, m.name as author_name, m.avatar_initials FROM updates u
      JOIN users m ON u.created_by = m.id ORDER BY u.created_at DESC`)).rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/updates', requireManager, async (req, res) => {
  try {
    const { title, content } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'title and content required' });
    const result = await query(
      'INSERT INTO updates (title,content,created_by) VALUES ($1,$2,$3) RETURNING id',
      [title, content, req.session.userId]
    );
    const newId = result.rows[0].id;
    res.status(201).json((await query('SELECT * FROM updates WHERE id=$1', [newId])).rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/updates/:id', requireManager, async (req, res) => {
  try {
    const result = await query('DELETE FROM updates WHERE id=$1', [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Highlights ────────────────────────────────────────────────────────────────

app.get('/api/highlights', requireAuth, async (req, res) => {
  try {
    const { month } = req.query;
    let sql = `SELECT h.*, u.name as employee_name, u.avatar_initials as emp_initials, m.name as creator_name
      FROM highlights h LEFT JOIN users u ON h.employee_id = u.id LEFT JOIN users m ON h.created_by = m.id`;
    let rows: any[];
    if (month) {
      rows = (await query(sql + ` WHERE h.month = $1 ORDER BY h.month DESC, h.created_at DESC`, [month])).rows;
    } else {
      rows = (await query(sql + ' ORDER BY h.month DESC, h.created_at DESC')).rows;
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/highlights', requireManager, async (req, res) => {
  try {
    const { type, title, description, employee_id, month } = req.body;
    if (!type || !title || !month) return res.status(400).json({ error: 'type, title, month required' });
    const result = await query(
      `INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [type, title, description || null, employee_id || null, month, req.session.userId]
    );
    const newId = result.rows[0].id;

    // Notify the highlighted employee
    if (employee_id) {
      const emp = (await query('SELECT email, name FROM users WHERE id=$1', [employee_id])).rows[0] as any;
      const typeLabel: Record<string,string> = { employee_month: '🏆 Employee of the Month', activity_month: '🎯 Activity of the Month', shoutout: '👏 Shoutout' };
      if (emp) {
        sendEmail(emp.email, `${typeLabel[type] || '⭐ Recognition'}: ${title}`,
          `<p>Hi ${emp.name},</p>
           <p>You've been recognised: <strong>${typeLabel[type] || type}</strong></p>
           <h3>${title}</h3>
           ${description ? `<p>${description}</p>` : ''}
           <p>Keep up the great work! 🎉</p>
           <p><a href="http://localhost:3001">View on Team Dashboard →</a></p>`
        );
      }
    }

    res.status(201).json((await query('SELECT * FROM highlights WHERE id=$1', [newId])).rows[0]);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/highlights/:id', requireManager, async (req, res) => {
  try {
    const result = await query('DELETE FROM highlights WHERE id=$1', [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Evaluations ──────────────────────────────────────────────────────────────

// All evaluations (manager only) — for Team Rating page
app.get('/api/evaluations', requireManager, async (req, res) => {
  try {
    const { year, type, period } = req.query as { year?: string; type?: string; period?: string };
    const conditions: string[] = [];
    const params: any[] = [];
    if (year) { conditions.push(`e.year = $${params.length + 1}`); params.push(year); }
    if (period) { conditions.push(`e.period = $${params.length + 1}`); params.push(period); }
    if (type === 'pm') {
      conditions.push("(e.eval_type = 'pm' OR (e.eval_type IS NULL AND u.role = 'manager'))");
    } else if (type === 'member') {
      conditions.push("(e.eval_type = 'member' OR (e.eval_type IS NULL AND u.role = 'employee'))");
    }
    let sql = `SELECT e.*, u.name as member_name, u.avatar_initials, u.job_title, u.department
      FROM evaluations e JOIN users u ON e.user_id = u.id`;
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ` ORDER BY e.year DESC, e.net_rating DESC`;
    res.json((await query(sql, params)).rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Available years (for filter dropdown)
app.get('/api/evaluations/years', requireManager, async (req, res) => {
  try {
    const years = (await query(`SELECT DISTINCT year FROM evaluations ORDER BY year DESC`)).rows;
    res.json(years.map((r: any) => r.year));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Available periods for a given year
app.get('/api/evaluations/periods', requireManager, async (req, res) => {
  try {
    const { year } = req.query as { year?: string };
    let sql = `SELECT DISTINCT period FROM evaluations`;
    const params: any[] = [];
    if (year) { sql += ` WHERE year = $1`; params.push(year); }
    sql += ` ORDER BY period`;
    const rows = (await query(sql, params)).rows;
    res.json(rows.map((r: any) => r.period));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/evaluations/export', requireManager, async (req, res) => {
  try {
    const { year } = req.query;
    let sql = `SELECT u.name as member_name, u.job_title, u.department, e.*
      FROM evaluations e JOIN users u ON e.user_id = u.id`;
    const params: any[] = [];
    if (year) { sql += ` WHERE e.year = $1`; params.push(year); }
    sql += ` ORDER BY e.year DESC, u.name`;
    const rows = (await query(sql, params)).rows;

    const esc = (v: any) => {
      if (v == null) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
    };
    const headers = ['Name','Job Title','Department','Year','TL','Type of Work','X-Factor',
      'Problem Solving','Project Scoping','Communication','Attention to Detail',
      'Attitude Towards Work','Compliance','Client Management','360 Feedback',
      'PIEX/Internal','Engagement','Net Rating','Comments'];
    const csvRows = rows.map((r: any) => [
      esc(r.member_name), esc(r.job_title), esc(r.department), r.year,
      esc(r.tl_name), esc(r.type_of_work), esc(r.x_factor),
      r.problem_solving, r.project_scoping, r.communication, r.attention_to_detail,
      r.attitude_towards_work, r.compliance, r.client_management, r.feedback_360,
      r.piex_internal, r.engagement, r.net_rating, esc(r.comments)
    ].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="team-ratings.csv"');
    res.send([headers.join(','), ...csvRows].join('\n'));
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/evaluations/:userId', requireAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.userId);
    if (req.session.role === 'employee' && req.session.userId !== targetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const evals = (await query(`SELECT e.*, u.name as created_by_name
      FROM evaluations e LEFT JOIN users u ON e.created_by = u.id
      WHERE e.user_id = $1 ORDER BY e.year DESC, e.period`, [targetId])).rows;
    res.json(evals);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/evaluations/bulk', requireManager, async (req, res) => {
  try {
    const { rows, eval_type, period } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });
    const evalType: string = eval_type === 'member' ? 'member' : 'pm';
    const evalPeriod: string = ['H1','H2','Q1','Q2','Q3','Q4','Annual'].includes(period) ? period : 'Annual';

    const results: any[] = [];
    const errors: string[] = [];

    const upsertSql = `INSERT INTO evaluations
      (user_id,year,period,eval_type,tl_name,type_of_work,x_factor,
       problem_solving,project_scoping,communication,attention_to_detail,
       attitude_towards_work,compliance,client_management,feedback_360,piex_internal,engagement,
       complexity_of_work,avg_feedback_rating,learning_curve,area_of_improvement,
       net_rating,comments,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      ON CONFLICT(user_id,year,period) DO UPDATE SET
        eval_type=EXCLUDED.eval_type,
        tl_name=EXCLUDED.tl_name, type_of_work=EXCLUDED.type_of_work, x_factor=EXCLUDED.x_factor,
        problem_solving=EXCLUDED.problem_solving, project_scoping=EXCLUDED.project_scoping,
        communication=EXCLUDED.communication, attention_to_detail=EXCLUDED.attention_to_detail,
        attitude_towards_work=EXCLUDED.attitude_towards_work, compliance=EXCLUDED.compliance,
        client_management=EXCLUDED.client_management, feedback_360=EXCLUDED.feedback_360,
        piex_internal=EXCLUDED.piex_internal, engagement=EXCLUDED.engagement,
        complexity_of_work=EXCLUDED.complexity_of_work, avg_feedback_rating=EXCLUDED.avg_feedback_rating,
        learning_curve=EXCLUDED.learning_curve, area_of_improvement=EXCLUDED.area_of_improvement,
        net_rating=EXCLUDED.net_rating, comments=EXCLUDED.comments, created_by=EXCLUDED.created_by`;

    await pool.query('BEGIN');
    try {
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r.name && !r.email) { errors.push(`Row ${i+1}: name or email required`); continue; }
        if (!r.year) { errors.push(`Row ${i+1}: year required`); continue; }

        let user: any = null;
        if (r.email) user = (await query('SELECT id FROM users WHERE lower(email)=$1', [r.email.toLowerCase().trim()])).rows[0];
        if (!user && r.name) user = (await query('SELECT id FROM users WHERE lower(name) LIKE $1', [`%${r.name.toLowerCase().trim()}%`])).rows[0];
        if (!user) { errors.push(`Row ${i+1}: no user found for "${r.name || r.email}"`); continue; }

        const n = (v: any) => (v !== undefined && v !== '' && v !== null) ? parseFloat(v) : null;
        await query(upsertSql, [
          user.id, parseInt(r.year), evalPeriod, evalType,
          r.tl_name||null, r.type_of_work||null, r.x_factor||null,
          n(r.problem_solving), n(r.project_scoping), n(r.communication),
          n(r.attention_to_detail), n(r.attitude_towards_work), n(r.compliance),
          n(r.client_management), n(r.feedback_360), n(r.piex_internal), n(r.engagement),
          n(r.complexity_of_work), n(r.avg_feedback_rating), n(r.learning_curve),
          r.area_of_improvement||null,
          n(r.net_rating), r.comments||null, req.session.userId
        ]);
        results.push({ name: r.name, year: r.year, period: evalPeriod });
      }
      await pool.query('COMMIT');
    } catch (e) {
      await pool.query('ROLLBACK');
      throw e;
    }

    res.status(201).json({ upserted: results.length, errors });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/evaluations/:id', requireManager, async (req, res) => {
  try {
    const result = await query('DELETE FROM evaluations WHERE id=$1', [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Skills ────────────────────────────────────────────────────────────────────

// Skills summary for dashboard (manager only)
app.get('/api/skills/summary', requireManager, async (req, res) => {
  try {
    const topSkills = (await query(`
      SELECT skill, COUNT(*) as count
      FROM user_skills
      GROUP BY skill ORDER BY count DESC, skill ASC
      LIMIT 30
    `)).rows;
    const noSkills = (await query(`
      SELECT COUNT(*) as c FROM users
      WHERE role='employee' AND id NOT IN (SELECT DISTINCT user_id FROM user_skills)
    `)).rows[0];
    const totalUnique = (await query('SELECT COUNT(DISTINCT skill) as c FROM user_skills')).rows[0];
    const withSkills = (await query('SELECT COUNT(DISTINCT user_id) as c FROM user_skills')).rows[0];
    res.json({ topSkills, noSkills: noSkills.c, totalUnique: totalUnique.c, withSkills: withSkills.c });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Get skills for a user (accessible to self or manager)
app.get('/api/users/:id/skills', requireAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (req.session.role !== 'manager' && req.session.userId !== targetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const skills = (await query('SELECT id, skill, created_at FROM user_skills WHERE user_id=$1 ORDER BY skill ASC', [targetId])).rows;
    res.json(skills);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Add a skill (self or manager)
app.post('/api/users/:id/skills', requireAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id);
    if (req.session.role !== 'manager' && req.session.userId !== targetId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { skill } = req.body;
    if (!skill || !skill.trim()) return res.status(400).json({ error: 'skill required' });
    try {
      const row = (await query(
        'INSERT INTO user_skills (user_id, skill) VALUES ($1,$2) RETURNING id, skill, created_at',
        [targetId, skill.trim()]
      )).rows[0];
      res.status(201).json(row);
    } catch {
      res.status(409).json({ error: 'Skill already exists' });
    }
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Delete a skill (self or manager)
app.delete('/api/user-skills/:id', requireAuth, async (req, res) => {
  try {
    const row = (await query('SELECT user_id FROM user_skills WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (req.session.role !== 'manager' && req.session.userId !== row.user_id) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await query('DELETE FROM user_skills WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// Export all team skills as CSV (manager only)
app.get('/api/skills/export', requireManager, async (req, res) => {
  try {
    const rows = (await query(`
      SELECT u.name, u.email, u.job_title, u.department, STRING_AGG(s.skill, ', ') as skills
      FROM users u
      LEFT JOIN user_skills s ON s.user_id = u.id
      WHERE u.role = 'employee'
      GROUP BY u.id, u.name, u.email, u.job_title, u.department
      ORDER BY u.name ASC
    `)).rows as any[];
    const header = 'Name,Email,Job Title,Department,Skills\n';
    const lines = rows.map(r =>
      [r.name, r.email, r.job_title||'', r.department||'', r.skills||'']
        .map(v => `"${String(v).replace(/"/g,'""')}"`)
        .join(',')
    ).join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="team-skills.csv"');
    res.send(header + lines);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Goal Comments ─────────────────────────────────────────────────────────────

app.get('/api/goals/:id/comments', requireAuth, async (req, res) => {
  try {
    const goal = (await query('SELECT * FROM goals WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!goal) return res.status(404).json({ error: 'Not found' });
    if (req.session.role === 'employee' && goal.assigned_to !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const comments = (await query(`SELECT c.*, u.name as author_name, u.avatar_initials, u.role as author_role
      FROM goal_comments c JOIN users u ON c.user_id = u.id
      WHERE c.goal_id = $1 ORDER BY c.created_at ASC`, [req.params.id])).rows;
    res.json(comments);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/goals/:id/comments', requireAuth, async (req, res) => {
  try {
    const goal = (await query('SELECT * FROM goals WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!goal) return res.status(404).json({ error: 'Not found' });
    if (req.session.role === 'employee' && goal.assigned_to !== req.session.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content required' });
    const result = await query(
      `INSERT INTO goal_comments (goal_id, user_id, content) VALUES ($1,$2,$3) RETURNING id`,
      [req.params.id, req.session.userId, content.trim()]
    );
    const newId = result.rows[0].id;
    const comment = (await query(`SELECT c.*, u.name as author_name, u.avatar_initials, u.role as author_role
      FROM goal_comments c JOIN users u ON c.user_id = u.id WHERE c.id=$1`, [newId])).rows[0];

    // Notify goal assignee when a manager comments (and vice versa)
    const commenter = (await query('SELECT name, role FROM users WHERE id=$1', [req.session.userId])).rows[0] as any;
    if (goal.assigned_to && goal.assigned_to !== req.session.userId) {
      const assignee = (await query('SELECT email, name FROM users WHERE id=$1', [goal.assigned_to])).rows[0] as any;
      if (assignee) {
        sendEmail(assignee.email, `💬 New comment on your goal: ${goal.title}`,
          `<p>Hi ${assignee.name},</p>
           <p><strong>${commenter.name}</strong> commented on your goal <strong>"${goal.title}"</strong>:</p>
           <blockquote style="border-left:3px solid #4a9e7f;padding-left:12px;color:#555">${content.trim()}</blockquote>
           <p><a href="http://localhost:3001">Reply on Team Dashboard →</a></p>`
        );
      }
    }

    res.status(201).json(comment);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/comments/:id', requireAuth, async (req, res) => {
  try {
    const comment = (await query('SELECT * FROM goal_comments WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!comment) return res.status(404).json({ error: 'Not found' });
    const isOwner = comment.user_id === req.session.userId;
    const isManager = req.session.role === 'manager';
    if (!isOwner && !isManager) return res.status(403).json({ error: 'Forbidden' });
    await query('DELETE FROM goal_comments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Deadline Reminder Cron (daily 8am) ────────────────────────────────────────

cron.schedule('0 8 * * *', async () => {
  console.log('⏰ Running deadline reminder check…');
  try {
    const upcoming = (await query(`
      SELECT g.*, u.email, u.name as assignee_name
      FROM goals g JOIN users u ON g.assigned_to = u.id
      WHERE g.status != 'completed'
        AND g.due_date IS NOT NULL
        AND g.reminder_sent = 0
        AND g.due_date::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '3 days'
    `)).rows as any[];

    for (const g of upcoming) {
      const daysLeft = Math.ceil((new Date(g.due_date).getTime() - Date.now()) / 86400000);
      const label = daysLeft === 0 ? 'due today' : `due in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
      sendEmail(g.email, `⏰ Goal reminder: "${g.title}" is ${label}`,
        `<p>Hi ${g.assignee_name},</p>
         <p>This is a reminder that your goal <strong>"${g.title}"</strong> is <strong>${label}</strong> (${g.due_date}).</p>
         <p>Current progress: ${g.progress}% — Status: ${g.status.replace('_', ' ')}</p>
         <p><a href="http://localhost:3001">Update your goal →</a></p>`
      );
      await query('UPDATE goals SET reminder_sent=1 WHERE id=$1', [g.id]);
      console.log(`  Reminder sent to ${g.email} for goal "${g.title}"`);
    }

    const overdue = (await query(`
      SELECT g.*, u.email, u.name as assignee_name
      FROM goals g JOIN users u ON g.assigned_to = u.id
      WHERE g.status != 'completed'
        AND g.due_date IS NOT NULL
        AND g.reminder_sent = 0
        AND g.due_date::date < CURRENT_DATE
    `)).rows as any[];

    for (const g of overdue) {
      sendEmail(g.email, `🚨 Goal overdue: "${g.title}"`,
        `<p>Hi ${g.assignee_name},</p>
         <p>Your goal <strong>"${g.title}"</strong> was due on <strong>${g.due_date}</strong> and is now overdue.</p>
         <p>Current progress: ${g.progress}%</p>
         <p><a href="http://localhost:3001">Update your goal →</a></p>`
      );
      await query('UPDATE goals SET reminder_sent=1 WHERE id=$1', [g.id]);
    }
  } catch (e) { console.error('Cron error:', e); }
});

// ── Announcements ─────────────────────────────────────────────────────────────

app.get('/api/announcements', requireAuth, async (req, res) => {
  try {
    const rows = (await query(`SELECT a.*, u.name as author_name
      FROM announcements a LEFT JOIN users u ON a.created_by = u.id
      WHERE a.is_active = 1 ORDER BY a.created_at DESC`)).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/announcements/all', requireManager, async (req, res) => {
  try {
    const rows = (await query(`SELECT a.*, u.name as author_name
      FROM announcements a LEFT JOIN users u ON a.created_by = u.id
      ORDER BY a.created_at DESC`)).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/announcements', requireManager, async (req, res) => {
  try {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'title and message required' });
    const result = await query(
      `INSERT INTO announcements (title, message, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [title.trim(), message.trim(), req.session.userId]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/announcements/:id/toggle', requireManager, async (req, res) => {
  try {
    const row = (await query('SELECT id, is_active FROM announcements WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!row) return res.status(404).json({ error: 'Not found' });
    await query('UPDATE announcements SET is_active=$1 WHERE id=$2', [row.is_active ? 0 : 1, row.id]);
    res.json({ ok: true, is_active: !row.is_active });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/announcements/:id', requireManager, async (req, res) => {
  try {
    const result = await query('DELETE FROM announcements WHERE id=$1', [req.params.id]);
    if ((result.rowCount ?? 0) === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Recent Activity ───────────────────────────────────────────────────────────

app.get('/api/activity', requireManager, async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 30;
    const rows = (await query(`
      SELECT * FROM (
        SELECT 'goal_completed' as type, u.name as actor, u.id as actor_id, g.title as subject, g.updated_at as ts
        FROM goals g JOIN users u ON g.assigned_to = u.id WHERE g.status = 'completed' AND g.assigned_to IS NOT NULL
        UNION ALL
        SELECT 'goal_updated' as type, u.name as actor, u.id as actor_id, g.title as subject, g.updated_at as ts
        FROM goals g JOIN users u ON g.assigned_to = u.id WHERE g.status != 'completed' AND g.updated_at != g.created_at AND g.assigned_to IS NOT NULL
        UNION ALL
        SELECT 'goal_created' as type, u.name as actor, u.id as actor_id, g.title as subject, g.created_at as ts
        FROM goals g JOIN users u ON g.created_by = u.id
        UNION ALL
        SELECT 'rating_added' as type, u.name as actor, u.id as actor_id, ('Rating added for ' || u.name) as subject, e.created_at as ts
        FROM evaluations e JOIN users u ON e.user_id = u.id
      ) sub
      ORDER BY ts DESC LIMIT $1
    `, [limit])).rows;
    res.json(rows);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Polls ─────────────────────────────────────────────────────────────────────

app.get('/api/polls', requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId!;
    const sessionUser = (await query('SELECT role, is_admin FROM users WHERE id=$1', [userId])).rows[0] as any;
    const isManager = sessionUser?.role === 'manager' || sessionUser?.is_admin;
    const polls = (await query(`
      SELECT p.*, u.name as author_name,
        (SELECT COUNT(*) FROM poll_responses WHERE poll_id = p.id) as response_count,
        (SELECT response FROM poll_responses WHERE poll_id = p.id AND user_id = $1) as my_response
      FROM polls p JOIN users u ON p.created_by = u.id
      ORDER BY p.created_at DESC
    `, [userId])).rows as any[];

    const result = await Promise.all(polls.map(async p => ({
      ...p,
      results: isManager ? (await query('SELECT response, COUNT(*) as n FROM poll_responses WHERE poll_id=$1 GROUP BY response', [p.id])).rows : null,
      respondents: isManager ? (await query(`SELECT u.name, pr.response, pr.created_at FROM poll_responses pr JOIN users u ON pr.user_id = u.id WHERE pr.poll_id=$1 ORDER BY pr.created_at DESC`, [p.id])).rows : null,
    })));
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/polls', requireManager, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question?.trim()) return res.status(400).json({ error: 'Question required' });
    const r = await query('INSERT INTO polls (question, created_by) VALUES ($1,$2) RETURNING id', [question.trim(), req.session.userId]);
    res.json({ id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.patch('/api/polls/:id/toggle', requireManager, async (req, res) => {
  try {
    const poll = (await query('SELECT * FROM polls WHERE id=$1', [req.params.id])).rows[0] as any;
    if (!poll) return res.status(404).json({ error: 'Not found' });
    await query('UPDATE polls SET is_active=$1 WHERE id=$2', [poll.is_active ? 0 : 1, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/polls/:id', requireManager, async (req, res) => {
  try {
    await query('DELETE FROM polls WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/polls/:id/respond', requireAuth, async (req, res) => {
  try {
    const { response } = req.body;
    const VALID = ['😊','😐','😟'];
    if (!VALID.includes(response)) return res.status(400).json({ error: 'Invalid response' });
    await query(
      `INSERT INTO poll_responses (poll_id, user_id, response) VALUES ($1,$2,$3)
       ON CONFLICT(poll_id, user_id) DO UPDATE SET response=EXCLUDED.response, created_at=NOW()`,
      [req.params.id, req.session.userId, response]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;

async function main() {
  await initSchema();
  await seed();
  setupMailer();
  app.listen(PORT, () => console.log(`Team Dashboard running on port ${PORT}`));
}

main().catch(console.error);
