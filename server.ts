import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import nodemailer from 'nodemailer';
import cron from 'node-cron';

const app = express();
const DB_PATH = process.env.DB_PATH || 'team.db';
const db = new Database(DB_PATH, { verbose: undefined });

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('manager','employee')),
    avatar_initials TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK(type IN ('team','individual')),
    assigned_to INTEGER REFERENCES users(id),
    progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'not_started' CHECK(status IN ('not_started','in_progress','completed')),
    due_date TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('employee_month','activity_month','shoutout')),
    title TEXT NOT NULL,
    description TEXT,
    employee_id INTEGER REFERENCES users(id),
    month TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS awards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    description TEXT,
    awarded_at TEXT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS goal_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    year INTEGER NOT NULL,
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
    net_rating REAL,
    comments TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, year)
  );
  CREATE TABLE IF NOT EXISTS user_skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, skill)
  );
  CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    question TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS poll_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    response TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(poll_id, user_id)
  );
`);

// Migrate existing DB: add profile columns to users if not present
const existingCols = (db.prepare("PRAGMA table_info(users)").all() as any[]).map(c => c.name);
if (!existingCols.includes('is_admin')) {
  db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0`);
  // Make alice admin by default
  db.prepare(`UPDATE users SET is_admin=1 WHERE email='alice@company.com'`).run();
}
const profileCols: [string, string][] = [
  ['job_title',            'TEXT'],
  ['department',           'TEXT'],
  ['joined_at',            'TEXT'],
  ['last_promotion_date',  'TEXT'],
  ['promotion_title',      'TEXT'],
  ['bio',                  'TEXT'],
];
for (const [col, type] of profileCols) {
  if (!existingCols.includes(col)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col} ${type}`);
  }
}

// Migrate goals: add reminder_sent flag if missing
const goalCols = (db.prepare("PRAGMA table_info(goals)").all() as any[]).map(c => c.name);
if (!goalCols.includes('reminder_sent')) {
  db.exec(`ALTER TABLE goals ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0`);
}

// Migrate evaluations: add eval_type + team-member score columns
const evalCols = (db.prepare("PRAGMA table_info(evaluations)").all() as any[]).map(c => c.name);
const evalNewCols: [string, string][] = [
  ['eval_type',           'TEXT'],
  ['complexity_of_work',  'REAL'],
  ['avg_feedback_rating', 'REAL'],
  ['learning_curve',      'REAL'],
  ['area_of_improvement', 'TEXT'],
];
for (const [col, type] of evalNewCols) {
  if (!evalCols.includes(col)) db.exec(`ALTER TABLE evaluations ADD COLUMN ${col} ${type}`);
}

// Migrate evaluations: add period column + change UNIQUE to (user_id, year, period)
if (!evalCols.includes('period')) {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    ALTER TABLE evaluations RENAME TO _evaluations_old;
    CREATE TABLE evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      year INTEGER NOT NULL,
      period TEXT NOT NULL DEFAULT 'Annual',
      eval_type TEXT,
      tl_name TEXT, type_of_work TEXT, x_factor TEXT,
      problem_solving REAL, project_scoping REAL, communication REAL,
      attention_to_detail REAL, attitude_towards_work REAL, compliance REAL,
      client_management REAL, feedback_360 REAL, piex_internal REAL, engagement REAL,
      complexity_of_work REAL, avg_feedback_rating REAL, learning_curve REAL,
      area_of_improvement TEXT, net_rating REAL, comments TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, year, period)
    );
    INSERT INTO evaluations
      SELECT id, user_id, year, 'Annual', eval_type, tl_name, type_of_work, x_factor,
        problem_solving, project_scoping, communication, attention_to_detail,
        attitude_towards_work, compliance, client_management, feedback_360,
        piex_internal, engagement, complexity_of_work, avg_feedback_rating,
        learning_curve, area_of_improvement, net_rating, comments,
        created_by, created_at
      FROM _evaluations_old;
    DROP TABLE _evaluations_old;
  `);
  db.pragma('foreign_keys = ON');
}

// ── Seed ─────────────────────────────────────────────────────────────────────

function seed() {
  const count = (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c;
  if (count > 0) {
    // patch existing seed users with profile data if missing
    db.prepare(`UPDATE users SET job_title='Engineering Manager', department='Engineering',
      joined_at='2021-03-01', last_promotion_date='2023-06-01', promotion_title='Senior Engineering Manager',
      bio='Leads the core product engineering team. Passionate about developer productivity and team culture.'
      WHERE email='alice@company.com' AND job_title IS NULL`).run();
    db.prepare(`UPDATE users SET job_title='Product Manager', department='Product',
      joined_at='2020-08-15', last_promotion_date='2022-11-01', promotion_title='Senior Product Manager',
      bio='Drives product strategy and roadmap. Previously at two SaaS startups.'
      WHERE email='frank@company.com' AND job_title IS NULL`).run();
    db.prepare(`UPDATE users SET job_title='Software Engineer', department='Engineering',
      joined_at='2022-01-10', last_promotion_date='2024-01-15', promotion_title='Software Engineer II',
      bio='Full-stack engineer focused on backend systems and infrastructure.'
      WHERE email='bob@company.com' AND job_title IS NULL`).run();
    db.prepare(`UPDATE users SET job_title='UX Designer', department='Design',
      joined_at='2021-09-20', last_promotion_date='2023-09-01', promotion_title='Senior UX Designer',
      bio='Designs intuitive user experiences. Led the redesign of the core dashboard.'
      WHERE email='carol@company.com' AND job_title IS NULL`).run();
    db.prepare(`UPDATE users SET job_title='Data Analyst', department='Analytics',
      joined_at='2023-03-06', joined_at='2023-03-06',
      bio='Builds data pipelines and dashboards for business intelligence.'
      WHERE email='dave@company.com' AND job_title IS NULL`).run();
    db.prepare(`UPDATE users SET job_title='Marketing Specialist', department='Marketing',
      joined_at='2022-06-01', last_promotion_date='2024-06-01', promotion_title='Marketing Lead',
      bio='Runs growth campaigns and manages social media presence.'
      WHERE email='eve@company.com' AND job_title IS NULL`).run();
    return;
  }

  const hash = (p: string) => bcrypt.hashSync(p, 10);
  const ins = db.prepare(`INSERT INTO users
    (name,email,password_hash,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);

  ins.run('Alice Manager','alice@company.com',hash('password123'),'manager','AM',
    'Engineering Manager','Engineering','2021-03-01','2023-06-01','Senior Engineering Manager',
    'Leads the core product engineering team. Passionate about developer productivity and team culture.');
  ins.run('Frank Manager','frank@company.com',hash('password123'),'manager','FM',
    'Product Manager','Product','2020-08-15','2022-11-01','Senior Product Manager',
    'Drives product strategy and roadmap. Previously at two SaaS startups.');
  ins.run('Bob Employee','bob@company.com',hash('password123'),'employee','BE',
    'Software Engineer','Engineering','2022-01-10','2024-01-15','Software Engineer II',
    'Full-stack engineer focused on backend systems and infrastructure.');
  ins.run('Carol Employee','carol@company.com',hash('password123'),'employee','CE',
    'UX Designer','Design','2021-09-20','2023-09-01','Senior UX Designer',
    'Designs intuitive user experiences. Led the redesign of the core dashboard.');
  ins.run('Dave Employee','dave@company.com',hash('password123'),'employee','DE',
    'Data Analyst','Analytics','2023-03-06',null,null,
    'Builds data pipelines and dashboards for business intelligence.');
  ins.run('Eve Employee','eve@company.com',hash('password123'),'employee','EE',
    'Marketing Specialist','Marketing','2022-06-01','2024-06-01','Marketing Lead',
    'Runs growth campaigns and manages social media presence.');

  const alice = (db.prepare("SELECT id FROM users WHERE email='alice@company.com'").get() as any).id;
  const bob   = (db.prepare("SELECT id FROM users WHERE email='bob@company.com'").get() as any).id;
  const carol = (db.prepare("SELECT id FROM users WHERE email='carol@company.com'").get() as any).id;
  const dave  = (db.prepare("SELECT id FROM users WHERE email='dave@company.com'").get() as any).id;

  const insGoal = db.prepare(`INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES (?,?,?,?,?,?,?,?)`);
  insGoal.run('Launch Q2 Product Update','Ship all Q2 milestones on schedule','team',null,65,'in_progress','2026-06-30',alice);
  insGoal.run('Improve Customer NPS to 70','Increase NPS score from 58 to 70','team',null,30,'in_progress','2026-12-31',alice);
  insGoal.run('Complete AWS Certification','Pass AWS Solutions Architect exam','individual',bob,80,'in_progress','2026-05-31',alice);
  insGoal.run('Lead Onboarding for 3 New Hires','Mentor and onboard Q2 joiners','individual',carol,100,'completed','2026-04-15',alice);
  insGoal.run('Build Q2 Analytics Dashboard','Deliver self-serve BI dashboard for all teams','individual',dave,45,'in_progress','2026-06-15',alice);

  db.prepare(`INSERT INTO updates (title,content,created_by) VALUES (?,?,?)`).run(
    'Welcome to Team Dashboard!','This is our new central hub for team goals, updates, and highlights. Check back regularly for the latest news.',alice);
  db.prepare(`INSERT INTO updates (title,content,created_by) VALUES (?,?,?)`).run(
    'Q2 Planning Wrap-up','We have finalized our Q2 goals. All individual goals have been assigned — check your Goals tab.',alice);

  db.prepare(`INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES (?,?,?,?,?,?)`).run(
    'employee_month','Employee of the Month: Carol','Carol successfully led the onboarding of 3 new hires ahead of schedule. Exceptional initiative!',carol,'2026-04',alice);
  db.prepare(`INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES (?,?,?,?,?,?)`).run(
    'activity_month','Activity of the Month: Team Hackathon','Our April hackathon produced 4 prototypes — two are moving to production.',null,'2026-04',alice);
  db.prepare(`INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES (?,?,?,?,?,?)`).run(
    'shoutout','Shoutout: Bob','Bob went above and beyond helping the infra team during the on-call rotation. Thank you!',bob,'2026-04',alice);

  const insAward = db.prepare(`INSERT INTO awards (user_id,title,description,awarded_at,created_by) VALUES (?,?,?,?,?)`);
  insAward.run(carol,'Best Team Player — Q1 2026','Recognized for outstanding collaboration and mentorship across the design and engineering teams.','2026-03-31',alice);
  insAward.run(bob,'Innovation Award 2025','Delivered a performance optimization that reduced API latency by 40%.','2025-12-15',alice);
  insAward.run(carol,'Onboarding Champion','Led onboarding for 3 new hires with perfect satisfaction scores.','2026-04-15',alice);
}
seed();

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
setupMailer();

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

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email) as any;
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Invalid credentials' });
  req.session.userId = user.id;
  req.session.role = user.role;
  req.session.isAdmin = !!user.is_admin;
  res.json({ id: user.id, name: user.name, email: user.email, role: user.role, is_admin: !!user.is_admin, avatar_initials: user.avatar_initials });
});
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role, job_title, department } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password and role are required' });
  if (!['manager', 'employee'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
  const initials = name.trim().split(/\s+/).map((w: string) => w[0].toUpperCase()).slice(0, 2).join('');
  const result = db.prepare(`INSERT INTO users (name,email,password_hash,role,avatar_initials,job_title,department,joined_at)
    VALUES (?,?,?,?,?,?,?,date('now'))`
  ).run(name.trim(), email.toLowerCase().trim(), bcrypt.hashSync(password, 10), role, initials, job_title || null, department || null);
  const user = db.prepare('SELECT id,name,email,role,avatar_initials FROM users WHERE id=?').get(result.lastInsertRowid) as any;
  req.session.userId = user.id;
  req.session.role = user.role;
  res.status(201).json(user);
});

app.post('/api/auth/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/auth/me', requireAuth, (req, res) => {
  const u = db.prepare('SELECT id,name,email,role,is_admin,avatar_initials FROM users WHERE id=?').get(req.session.userId) as any;
  res.json({ ...u, is_admin: !!u.is_admin });
});

// ── Users (simple list for dropdowns) ────────────────────────────────────────

app.get('/api/users', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT id,name,email,role,avatar_initials FROM users ORDER BY name').all());
});

// ── Members (full profiles) ───────────────────────────────────────────────────

app.get('/api/members', requireAuth, (req, res) => {
  const members = db.prepare(`
    SELECT id, name, email, role, avatar_initials, job_title, department,
           joined_at, last_promotion_date, promotion_title, bio
    FROM users ORDER BY name
  `).all() as any[];

  // attach goal counts
  for (const m of members) {
    const gc = db.prepare(`SELECT COUNT(*) as total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as done,
      ROUND(AVG(progress),0) as avg
      FROM goals WHERE assigned_to=?`).get(m.id) as any;
    m.goal_total = gc.total;
    m.goal_done = gc.done || 0;
    m.goal_avg_progress = gc.avg || 0;
    const aw = db.prepare(`SELECT COUNT(*) as c FROM awards WHERE user_id=?`).get(m.id) as any;
    m.award_count = aw.c;
  }
  res.json(members);
});

app.get('/api/members/:id', requireAuth, (req, res) => {
  const member = db.prepare(`
    SELECT id, name, email, role, avatar_initials, job_title, department,
           joined_at, last_promotion_date, promotion_title, bio
    FROM users WHERE id=?
  `).get(req.params.id) as any;
  if (!member) return res.status(404).json({ error: 'Not found' });

  member.goals = db.prepare(`
    SELECT g.*, u.name as creator_name FROM goals g
    LEFT JOIN users u ON g.created_by = u.id
    WHERE g.assigned_to=? ORDER BY g.created_at DESC
  `).all(req.params.id);

  member.awards = db.prepare(`
    SELECT a.*, u.name as given_by FROM awards a
    LEFT JOIN users u ON a.created_by = u.id
    WHERE a.user_id=? ORDER BY a.awarded_at DESC
  `).all(req.params.id);

  member.highlights = db.prepare(`
    SELECT h.*, u.name as creator_name FROM highlights h
    LEFT JOIN users u ON h.created_by = u.id
    WHERE h.employee_id=? ORDER BY h.month DESC
  `).all(req.params.id);

  res.json(member);
});

app.patch('/api/members/:id', requireManager, (req, res) => {
  const { job_title, department, joined_at, last_promotion_date, promotion_title, bio, name } = req.body;
  db.prepare(`UPDATE users SET
    name=COALESCE(?,name), job_title=COALESCE(?,job_title), department=COALESCE(?,department),
    joined_at=COALESCE(?,joined_at), last_promotion_date=COALESCE(?,last_promotion_date),
    promotion_title=COALESCE(?,promotion_title), bio=COALESCE(?,bio)
    WHERE id=?`
  ).run(name, job_title, department, joined_at, last_promotion_date, promotion_title, bio, req.params.id);
  res.json(db.prepare('SELECT id,name,email,role,avatar_initials,job_title,department,joined_at,last_promotion_date,promotion_title,bio FROM users WHERE id=?').get(req.params.id));
});

// ── Awards ────────────────────────────────────────────────────────────────────

app.post('/api/members/:id/awards', requireManager, (req, res) => {
  const { title, description, awarded_at } = req.body;
  if (!title || !awarded_at) return res.status(400).json({ error: 'title and awarded_at required' });
  const result = db.prepare(`INSERT INTO awards (user_id,title,description,awarded_at,created_by) VALUES (?,?,?,?,?)`)
    .run(req.params.id, title, description || null, awarded_at, req.session.userId);
  res.status(201).json(db.prepare('SELECT * FROM awards WHERE id=?').get(result.lastInsertRowid));
});

// Admin: delete a team member and all their data
app.delete('/api/members/:id', requireAdmin, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (targetId === req.session.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  const user = db.prepare('SELECT id, name FROM users WHERE id=?').get(targetId) as any;
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.transaction(() => {
    db.prepare('DELETE FROM user_skills WHERE user_id=?').run(targetId);
    db.prepare('DELETE FROM evaluations WHERE user_id=? OR created_by=?').run(targetId, targetId);
    db.prepare('DELETE FROM awards WHERE user_id=? OR created_by=?').run(targetId, targetId);
    db.prepare('DELETE FROM goal_comments WHERE user_id=?').run(targetId);
    // goals created_by is NOT NULL — delete them (cascades their comments)
    db.prepare('DELETE FROM goals WHERE created_by=?').run(targetId);
    // goals merely assigned_to this user — nullify
    db.prepare('UPDATE goals SET assigned_to=NULL WHERE assigned_to=?').run(targetId);
    db.prepare('DELETE FROM updates WHERE created_by=?').run(targetId);
    // highlights created_by is NOT NULL — delete them
    db.prepare('DELETE FROM highlights WHERE created_by=?').run(targetId);
    // highlights where this user was the featured employee — nullify
    db.prepare('UPDATE highlights SET employee_id=NULL WHERE employee_id=?').run(targetId);
    db.prepare('DELETE FROM users WHERE id=?').run(targetId);
  })();
  res.json({ ok: true, deleted: user.name });
});

app.delete('/api/awards/:id', requireManager, (req, res) => {
  const result = db.prepare('DELETE FROM awards WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Goals ─────────────────────────────────────────────────────────────────────

app.get('/api/goals', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const role = req.session.role;
  const { type } = req.query;
  let query = `SELECT g.*, u.name as assigned_name, u.avatar_initials, m.name as creator_name,
    (SELECT COUNT(*) FROM goal_comments c WHERE c.goal_id = g.id) as comment_count
    FROM goals g LEFT JOIN users u ON g.assigned_to = u.id LEFT JOIN users m ON g.created_by = m.id`;
  const conditions: string[] = [];
  const params: any[] = [];
  if (role === 'employee') {
    // employees see only their own goals
    conditions.push('g.assigned_to = ?'); params.push(userId);
  } else {
    // managers: exclude goals assigned to managers (those are personal/private)
    // show: team goals, unassigned goals, goals assigned to employees
    conditions.push("(g.type = 'team' OR g.assigned_to IS NULL OR u.role = 'employee')");
  }
  if (type === 'team') conditions.push("g.type = 'team'");
  if (type === 'individual') conditions.push("g.type = 'individual'");
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY g.created_at DESC';
  res.json(db.prepare(query).all(...params));
});

// Personal goals — only visible to the current user (any role)
app.get('/api/my-goals', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const goals = db.prepare(`SELECT g.*, u.name as assigned_name, u.avatar_initials,
    (SELECT COUNT(*) FROM goal_comments c WHERE c.goal_id = g.id) as comment_count
    FROM goals g LEFT JOIN users u ON g.assigned_to = u.id
    WHERE g.assigned_to = ? ORDER BY g.created_at DESC`).all(userId);
  res.json(goals);
});

app.post('/api/my-goals', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const { title, description, progress, status, due_date } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const result = db.prepare(
    `INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES (?,?,?,?,?,?,?,?)`
  ).run(title, description || null, 'individual', userId, progress || 0, status || 'not_started', due_date || null, userId);
  res.status(201).json(db.prepare('SELECT * FROM goals WHERE id=?').get(result.lastInsertRowid));
});

// ── Goals Export (must be before /:id) ───────────────────────────────────────

app.get('/api/goals/export', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const role = req.session.role;
  let goals: any[];
  if (role === 'manager') {
    goals = db.prepare(`SELECT g.title, g.type, u.name as assigned_to, g.status, g.progress, g.due_date, g.description, g.created_at
      FROM goals g LEFT JOIN users u ON g.assigned_to = u.id
      WHERE (g.type = 'team' OR g.assigned_to IS NULL OR u.role = 'employee')
      ORDER BY g.type, u.name, g.created_at`).all() as any[];
  } else {
    goals = db.prepare(`SELECT g.title, g.type, u.name as assigned_to, g.status, g.progress, g.due_date, g.description, g.created_at
      FROM goals g LEFT JOIN users u ON g.assigned_to = u.id
      WHERE g.assigned_to = ? ORDER BY g.created_at`).all(userId) as any[];
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
});

app.get('/api/my-goals/export', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const goals = db.prepare(`SELECT g.title, g.status, g.progress, g.due_date, g.description, g.created_at
    FROM goals g WHERE g.assigned_to = ? ORDER BY g.created_at`).all(userId) as any[];

  const escape = (v: any) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Title', 'Status', 'Progress %', 'Due Date', 'Description', 'Created At'];
  const rows = goals.map(g => [
    escape(g.title), escape(g.status), g.progress,
    escape(g.due_date), escape(g.description), escape(g.created_at?.split('T')[0])
  ].join(','));
  const csv = [header.join(','), ...rows].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="my-goals-export.csv"');
  res.send(csv);
});

app.post('/api/goals/bulk', requireManager, (req, res) => {
  const { goals } = req.body;
  if (!Array.isArray(goals) || goals.length === 0) return res.status(400).json({ error: 'goals array required' });
  const ins = db.prepare(`INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES (?,?,?,?,?,?,?,?)`);
  const results: any[] = [];
  const errors: string[] = [];

  const insertMany = db.transaction(() => {
    for (let i = 0; i < goals.length; i++) {
      const g = goals[i];
      if (!g.title || !g.type) { errors.push(`Row ${i + 1}: title and type are required`); continue; }
      if (!['team', 'individual'].includes(g.type)) { errors.push(`Row ${i + 1}: type must be "team" or "individual"`); continue; }

      let assignedId: number | null = null;
      if (g.assigned_to) {
        assignedId = parseInt(g.assigned_to) || null;
      } else if (g.assigned_email) {
        const u = db.prepare('SELECT id FROM users WHERE email=?').get(g.assigned_email.trim().toLowerCase()) as any;
        if (!u) { errors.push(`Row ${i + 1}: no user found with email "${g.assigned_email}"`); continue; }
        assignedId = u.id;
      }
      const progress = Math.min(100, Math.max(0, parseInt(g.progress) || 0));
      const status = ['not_started', 'in_progress', 'completed'].includes(g.status) ? g.status : 'not_started';
      const r = ins.run(g.title.trim(), g.description || null, g.type, assignedId, progress, status, g.due_date || null, req.session.userId);
      results.push({ id: r.lastInsertRowid, title: g.title });
    }
  });
  insertMany();
  res.status(201).json({ inserted: results.length, errors });
});

app.post('/api/goals', requireManager, (req, res) => {
  const { title, description, type, assigned_to, progress, status, due_date } = req.body;
  if (!title || !type) return res.status(400).json({ error: 'title and type required' });
  const result = db.prepare(`INSERT INTO goals (title,description,type,assigned_to,progress,status,due_date,created_by) VALUES (?,?,?,?,?,?,?,?)`)
    .run(title, description || null, type, assigned_to || null, progress || 0, status || 'not_started', due_date || null, req.session.userId);
  res.status(201).json(db.prepare('SELECT * FROM goals WHERE id=?').get(result.lastInsertRowid));
});

app.patch('/api/goals/:id', requireAuth, async (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id) as any;
  if (!goal) return res.status(404).json({ error: 'Not found' });
  const isManager = req.session.role === 'manager';
  const isAssignee = goal.assigned_to === req.session.userId;
  if (!isManager && !isAssignee) return res.status(403).json({ error: 'Forbidden' });
  const { title, description, type, assigned_to, progress, status, due_date } = req.body;
  const wasCompleted = goal.status === 'completed';
  if (isManager) {
    db.prepare(`UPDATE goals SET title=COALESCE(?,title), description=COALESCE(?,description),
      type=COALESCE(?,type), assigned_to=?, progress=COALESCE(?,progress),
      status=COALESCE(?,status), due_date=COALESCE(?,due_date), updated_at=datetime('now') WHERE id=?`)
      .run(title, description, type, assigned_to !== undefined ? assigned_to : goal.assigned_to, progress, status, due_date, req.params.id);
  } else {
    db.prepare(`UPDATE goals SET title=COALESCE(?,title), description=COALESCE(?,description),
      progress=COALESCE(?,progress), status=COALESCE(?,status), due_date=COALESCE(?,due_date),
      updated_at=datetime('now') WHERE id=?`)
      .run(title, description, progress, status, due_date, req.params.id);
  }
  const updated = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id) as any;

  // 🔔 Notify managers when a goal is marked complete
  if (!wasCompleted && updated.status === 'completed') {
    const assignee = updated.assigned_to
      ? db.prepare('SELECT name FROM users WHERE id=?').get(updated.assigned_to) as any
      : null;
    const managers = db.prepare("SELECT email, name FROM users WHERE role='manager'").all() as any[];
    for (const mgr of managers) {
      sendEmail(mgr.email, `✅ Goal Completed: ${updated.title}`,
        `<p>Hi ${mgr.name},</p>
         <p><strong>${assignee?.name || 'Someone'}</strong> just marked the goal <strong>"${updated.title}"</strong> as <strong>completed</strong>.</p>
         <p>Progress: ${updated.progress}%</p>
         <p><a href="http://localhost:3001">View Dashboard →</a></p>`
      );
    }
    // Also notify the assignee if they didn't mark it themselves
    if (updated.assigned_to && updated.assigned_to !== req.session.userId) {
      const assigneeUser = db.prepare('SELECT email, name FROM users WHERE id=?').get(updated.assigned_to) as any;
      if (assigneeUser) {
        sendEmail(assigneeUser.email, `🎉 Goal Completed: ${updated.title}`,
          `<p>Hi ${assigneeUser.name},</p>
           <p>Your goal <strong>"${updated.title}"</strong> has been marked as <strong>completed</strong>. Great work!</p>`
        );
      }
    }
  }

  res.json(updated);
});

app.delete('/api/goals/:id', requireAuth, (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id) as any;
  if (!goal) return res.status(404).json({ error: 'Not found' });
  const isManager = req.session.role === 'manager';
  const isAssignee = goal.assigned_to === req.session.userId;
  if (!isManager && !isAssignee) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM goals WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const role = req.session.role;
  const teamGoals = (db.prepare(`SELECT COUNT(*) as c FROM goals WHERE type='team'`).get() as any).c;
  const teamCompleted = (db.prepare(`SELECT COUNT(*) as c FROM goals WHERE type='team' AND status='completed'`).get() as any).c;
  const avgProgress = (db.prepare(`SELECT ROUND(AVG(progress),1) as avg FROM goals WHERE type='team'`).get() as any).avg || 0;
  let myGoals = null, myCompleted = null;
  if (role === 'employee') {
    myGoals = (db.prepare(`SELECT COUNT(*) as c FROM goals WHERE assigned_to=?`).get(userId) as any).c;
    myCompleted = (db.prepare(`SELECT COUNT(*) as c FROM goals WHERE assigned_to=? AND status='completed'`).get(userId) as any).c;
  }
  res.json({
    teamGoals, teamCompleted, teamAvgProgress: avgProgress,
    myGoals, myCompleted,
    totalUpdates: (db.prepare(`SELECT COUNT(*) as c FROM updates`).get() as any).c,
    totalHighlights: (db.prepare(`SELECT COUNT(*) as c FROM highlights`).get() as any).c,
  });
});

// ── Updates ───────────────────────────────────────────────────────────────────

app.get('/api/updates', requireAuth, (req, res) => {
  res.json(db.prepare(`SELECT u.*, m.name as author_name, m.avatar_initials FROM updates u
    JOIN users m ON u.created_by = m.id ORDER BY u.created_at DESC`).all());
});
app.post('/api/updates', requireManager, (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title and content required' });
  const result = db.prepare('INSERT INTO updates (title,content,created_by) VALUES (?,?,?)').run(title, content, req.session.userId);
  res.status(201).json(db.prepare('SELECT * FROM updates WHERE id=?').get(result.lastInsertRowid));
});
app.delete('/api/updates/:id', requireManager, (req, res) => {
  const result = db.prepare('DELETE FROM updates WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Highlights ────────────────────────────────────────────────────────────────

app.get('/api/highlights', requireAuth, (req, res) => {
  const { month } = req.query;
  let query = `SELECT h.*, u.name as employee_name, u.avatar_initials as emp_initials, m.name as creator_name
    FROM highlights h LEFT JOIN users u ON h.employee_id = u.id LEFT JOIN users m ON h.created_by = m.id`;
  query += month ? ` WHERE h.month = ?` : ' ORDER BY h.month DESC, h.created_at DESC';
  res.json(month ? db.prepare(query).all(month) : db.prepare(query).all());
});
app.post('/api/highlights', requireManager, (req, res) => {
  const { type, title, description, employee_id, month } = req.body;
  if (!type || !title || !month) return res.status(400).json({ error: 'type, title, month required' });
  const result = db.prepare(`INSERT INTO highlights (type,title,description,employee_id,month,created_by) VALUES (?,?,?,?,?,?)`)
    .run(type, title, description || null, employee_id || null, month, req.session.userId);

  // 🔔 Notify the highlighted employee
  if (employee_id) {
    const emp = db.prepare('SELECT email, name FROM users WHERE id=?').get(employee_id) as any;
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

  res.status(201).json(db.prepare('SELECT * FROM highlights WHERE id=?').get(result.lastInsertRowid));
});
app.delete('/api/highlights/:id', requireManager, (req, res) => {
  const result = db.prepare('DELETE FROM highlights WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Evaluations ──────────────────────────────────────────────────────────────

// All evaluations (manager only) — for Team Rating page
app.get('/api/evaluations', requireManager, (req, res) => {
  const { year, type, period } = req.query as { year?: string; type?: string; period?: string };
  const conditions: string[] = [];
  const params: any[] = [];
  if (year) { conditions.push('e.year = ?'); params.push(year); }
  if (period) { conditions.push('e.period = ?'); params.push(period); }
  if (type === 'pm') {
    conditions.push("(e.eval_type = 'pm' OR (e.eval_type IS NULL AND u.role = 'manager'))");
  } else if (type === 'member') {
    conditions.push("(e.eval_type = 'member' OR (e.eval_type IS NULL AND u.role = 'employee'))");
  }
  let query = `SELECT e.*, u.name as member_name, u.avatar_initials, u.job_title, u.department
    FROM evaluations e JOIN users u ON e.user_id = u.id`;
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ` ORDER BY e.year DESC, e.net_rating DESC`;
  res.json(db.prepare(query).all(...params));
});

// Available years (for filter dropdown)
app.get('/api/evaluations/years', requireManager, (req, res) => {
  const years = db.prepare(`SELECT DISTINCT year FROM evaluations ORDER BY year DESC`).all();
  res.json(years.map((r: any) => r.year));
});

// Available periods for a given year
app.get('/api/evaluations/periods', requireManager, (req, res) => {
  const { year } = req.query as { year?: string };
  let q = `SELECT DISTINCT period FROM evaluations`;
  if (year) q += ` WHERE year = ?`;
  q += ` ORDER BY period`;
  const rows: any[] = year ? (db.prepare(q).all(year) as any[]) : (db.prepare(q).all() as any[]);
  res.json(rows.map((r: any) => r.period));
});

app.get('/api/evaluations/export', requireManager, (req, res) => {
  const { year } = req.query;
  let query = `SELECT u.name as member_name, u.job_title, u.department, e.*
    FROM evaluations e JOIN users u ON e.user_id = u.id`;
  if (year) query += ` WHERE e.year = ?`;
  query += ` ORDER BY e.year DESC, u.name`;
  const rows: any[] = year ? db.prepare(query).all(year) as any[] : db.prepare(query).all() as any[];

  const esc = (v: any) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  };
  const headers = ['Name','Job Title','Department','Year','TL','Type of Work','X-Factor',
    'Problem Solving','Project Scoping','Communication','Attention to Detail',
    'Attitude Towards Work','Compliance','Client Management','360 Feedback',
    'PIEX/Internal','Engagement','Net Rating','Comments'];
  const csvRows = rows.map(r => [
    esc(r.member_name), esc(r.job_title), esc(r.department), r.year,
    esc(r.tl_name), esc(r.type_of_work), esc(r.x_factor),
    r.problem_solving, r.project_scoping, r.communication, r.attention_to_detail,
    r.attitude_towards_work, r.compliance, r.client_management, r.feedback_360,
    r.piex_internal, r.engagement, r.net_rating, esc(r.comments)
  ].join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="team-ratings.csv"');
  res.send([headers.join(','), ...csvRows].join('\n'));
});

app.get('/api/evaluations/:userId', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.userId);
  // employees can only see their own evaluations
  if (req.session.role === 'employee' && req.session.userId !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const evals = db.prepare(`SELECT e.*, u.name as created_by_name
    FROM evaluations e LEFT JOIN users u ON e.created_by = u.id
    WHERE e.user_id = ? ORDER BY e.year DESC, e.period`).all(targetId);
  res.json(evals);
});

app.post('/api/evaluations/bulk', requireManager, (req, res) => {
  const { rows, eval_type, period } = req.body;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows array required' });
  const evalType: string = eval_type === 'member' ? 'member' : 'pm';
  const evalPeriod: string = ['H1','H2','Q1','Q2','Q3','Q4','Annual'].includes(period) ? period : 'Annual';

  const results: any[] = [];
  const errors: string[] = [];

  const upsert = db.prepare(`INSERT INTO evaluations
    (user_id,year,period,eval_type,tl_name,type_of_work,x_factor,
     problem_solving,project_scoping,communication,attention_to_detail,
     attitude_towards_work,compliance,client_management,feedback_360,piex_internal,engagement,
     complexity_of_work,avg_feedback_rating,learning_curve,area_of_improvement,
     net_rating,comments,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,year,period) DO UPDATE SET
      eval_type=excluded.eval_type,
      tl_name=excluded.tl_name, type_of_work=excluded.type_of_work, x_factor=excluded.x_factor,
      problem_solving=excluded.problem_solving, project_scoping=excluded.project_scoping,
      communication=excluded.communication, attention_to_detail=excluded.attention_to_detail,
      attitude_towards_work=excluded.attitude_towards_work, compliance=excluded.compliance,
      client_management=excluded.client_management, feedback_360=excluded.feedback_360,
      piex_internal=excluded.piex_internal, engagement=excluded.engagement,
      complexity_of_work=excluded.complexity_of_work, avg_feedback_rating=excluded.avg_feedback_rating,
      learning_curve=excluded.learning_curve, area_of_improvement=excluded.area_of_improvement,
      net_rating=excluded.net_rating, comments=excluded.comments, created_by=excluded.created_by`);

  const txn = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r.name && !r.email) { errors.push(`Row ${i+1}: name or email required`); continue; }
      if (!r.year) { errors.push(`Row ${i+1}: year required`); continue; }

      let user: any = null;
      if (r.email) user = db.prepare('SELECT id FROM users WHERE lower(email)=?').get(r.email.toLowerCase().trim());
      if (!user && r.name) user = db.prepare('SELECT id FROM users WHERE lower(name) LIKE ?').get(`%${r.name.toLowerCase().trim()}%`);
      if (!user) { errors.push(`Row ${i+1}: no user found for "${r.name || r.email}"`); continue; }

      const n = (v: any) => (v !== undefined && v !== '' && v !== null) ? parseFloat(v) : null;
      upsert.run(
        user.id, parseInt(r.year), evalPeriod, evalType,
        r.tl_name||null, r.type_of_work||null, r.x_factor||null,
        n(r.problem_solving), n(r.project_scoping), n(r.communication),
        n(r.attention_to_detail), n(r.attitude_towards_work), n(r.compliance),
        n(r.client_management), n(r.feedback_360), n(r.piex_internal), n(r.engagement),
        n(r.complexity_of_work), n(r.avg_feedback_rating), n(r.learning_curve),
        r.area_of_improvement||null,
        n(r.net_rating), r.comments||null, req.session.userId
      );
      results.push({ name: r.name, year: r.year, period: evalPeriod });
    }
  });
  txn();
  res.status(201).json({ upserted: results.length, errors });
});

app.delete('/api/evaluations/:id', requireManager, (req, res) => {
  const result = db.prepare('DELETE FROM evaluations WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Skills ────────────────────────────────────────────────────────────────────

// Skills summary for dashboard (manager only)
app.get('/api/skills/summary', requireManager, (req, res) => {
  // top skills by count
  const topSkills = db.prepare(`
    SELECT skill, COUNT(*) as count
    FROM user_skills
    GROUP BY skill ORDER BY count DESC, skill ASC
    LIMIT 30
  `).all();
  // members with no skills
  const noSkills = db.prepare(`
    SELECT COUNT(*) as c FROM users
    WHERE role='employee' AND id NOT IN (SELECT DISTINCT user_id FROM user_skills)
  `).get() as any;
  // total unique skills
  const totalUnique = db.prepare('SELECT COUNT(DISTINCT skill) as c FROM user_skills').get() as any;
  // total members with at least one skill
  const withSkills = db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM user_skills').get() as any;
  res.json({ topSkills, noSkills: noSkills.c, totalUnique: totalUnique.c, withSkills: withSkills.c });
});

// Get skills for a user (accessible to self or manager)
app.get('/api/users/:id/skills', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.session.role !== 'manager' && req.session.userId !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const skills = db.prepare('SELECT id, skill, created_at FROM user_skills WHERE user_id=? ORDER BY skill ASC').all(targetId);
  res.json(skills);
});

// Add a skill (self or manager)
app.post('/api/users/:id/skills', requireAuth, (req, res) => {
  const targetId = parseInt(req.params.id);
  if (req.session.role !== 'manager' && req.session.userId !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { skill } = req.body;
  if (!skill || !skill.trim()) return res.status(400).json({ error: 'skill required' });
  try {
    const row = db.prepare('INSERT INTO user_skills (user_id, skill) VALUES (?,?) RETURNING id, skill, created_at')
      .get(targetId, skill.trim()) as any;
    res.status(201).json(row);
  } catch {
    res.status(409).json({ error: 'Skill already exists' });
  }
});

// Delete a skill (self or manager)
app.delete('/api/user-skills/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT user_id FROM user_skills WHERE id=?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.session.role !== 'manager' && req.session.userId !== row.user_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  db.prepare('DELETE FROM user_skills WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Export all team skills as CSV (manager only)
app.get('/api/skills/export', requireManager, (req, res) => {
  const rows = db.prepare(`
    SELECT u.name, u.email, u.job_title, u.department, GROUP_CONCAT(s.skill, ', ') as skills
    FROM users u
    LEFT JOIN user_skills s ON s.user_id = u.id
    WHERE u.role = 'employee'
    GROUP BY u.id
    ORDER BY u.name ASC
  `).all() as any[];
  const header = 'Name,Email,Job Title,Department,Skills\n';
  const lines = rows.map(r =>
    [r.name, r.email, r.job_title||'', r.department||'', r.skills||'']
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(',')
  ).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="team-skills.csv"');
  res.send(header + lines);
});

// ── Goal Comments ─────────────────────────────────────────────────────────────

app.get('/api/goals/:id/comments', requireAuth, (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id) as any;
  if (!goal) return res.status(404).json({ error: 'Not found' });
  // employees can only see comments on their own goals
  if (req.session.role === 'employee' && goal.assigned_to !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const comments = db.prepare(`SELECT c.*, u.name as author_name, u.avatar_initials, u.role as author_role
    FROM goal_comments c JOIN users u ON c.user_id = u.id
    WHERE c.goal_id = ? ORDER BY c.created_at ASC`).all(req.params.id);
  res.json(comments);
});

app.post('/api/goals/:id/comments', requireAuth, (req, res) => {
  const goal = db.prepare('SELECT * FROM goals WHERE id=?').get(req.params.id) as any;
  if (!goal) return res.status(404).json({ error: 'Not found' });
  if (req.session.role === 'employee' && goal.assigned_to !== req.session.userId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  const result = db.prepare(`INSERT INTO goal_comments (goal_id, user_id, content) VALUES (?,?,?)`)
    .run(req.params.id, req.session.userId, content.trim());
  const comment = db.prepare(`SELECT c.*, u.name as author_name, u.avatar_initials, u.role as author_role
    FROM goal_comments c JOIN users u ON c.user_id = u.id WHERE c.id=?`).get(result.lastInsertRowid);

  // 🔔 Notify goal assignee when a manager comments (and vice versa)
  const commenter = db.prepare('SELECT name, role FROM users WHERE id=?').get(req.session.userId) as any;
  if (goal.assigned_to && goal.assigned_to !== req.session.userId) {
    const assignee = db.prepare('SELECT email, name FROM users WHERE id=?').get(goal.assigned_to) as any;
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
});

app.delete('/api/comments/:id', requireAuth, (req, res) => {
  const comment = db.prepare('SELECT * FROM goal_comments WHERE id=?').get(req.params.id) as any;
  if (!comment) return res.status(404).json({ error: 'Not found' });
  const isOwner = comment.user_id === req.session.userId;
  const isManager = req.session.role === 'manager';
  if (!isOwner && !isManager) return res.status(403).json({ error: 'Forbidden' });
  db.prepare('DELETE FROM goal_comments WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── Deadline Reminder Cron (daily 8am) ────────────────────────────────────────

cron.schedule('0 8 * * *', () => {
  console.log('⏰ Running deadline reminder check…');
  const upcoming = db.prepare(`
    SELECT g.*, u.email, u.name as assignee_name
    FROM goals g JOIN users u ON g.assigned_to = u.id
    WHERE g.status != 'completed'
      AND g.due_date IS NOT NULL
      AND g.reminder_sent = 0
      AND date(g.due_date) BETWEEN date('now') AND date('now', '+3 days')
  `).all() as any[];

  for (const g of upcoming) {
    const daysLeft = Math.ceil((new Date(g.due_date).getTime() - Date.now()) / 86400000);
    const label = daysLeft === 0 ? 'due today' : `due in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
    sendEmail(g.email, `⏰ Goal reminder: "${g.title}" is ${label}`,
      `<p>Hi ${g.assignee_name},</p>
       <p>This is a reminder that your goal <strong>"${g.title}"</strong> is <strong>${label}</strong> (${g.due_date}).</p>
       <p>Current progress: ${g.progress}% — Status: ${g.status.replace('_', ' ')}</p>
       <p><a href="http://localhost:3001">Update your goal →</a></p>`
    );
    db.prepare('UPDATE goals SET reminder_sent=1 WHERE id=?').run(g.id);
    console.log(`  Reminder sent to ${g.email} for goal "${g.title}"`);
  }

  // Also flag overdue goals once
  const overdue = db.prepare(`
    SELECT g.*, u.email, u.name as assignee_name
    FROM goals g JOIN users u ON g.assigned_to = u.id
    WHERE g.status != 'completed'
      AND g.due_date IS NOT NULL
      AND g.reminder_sent = 0
      AND date(g.due_date) < date('now')
  `).all() as any[];

  for (const g of overdue) {
    sendEmail(g.email, `🚨 Goal overdue: "${g.title}"`,
      `<p>Hi ${g.assignee_name},</p>
       <p>Your goal <strong>"${g.title}"</strong> was due on <strong>${g.due_date}</strong> and is now overdue.</p>
       <p>Current progress: ${g.progress}%</p>
       <p><a href="http://localhost:3001">Update your goal →</a></p>`
    );
    db.prepare('UPDATE goals SET reminder_sent=1 WHERE id=?').run(g.id);
  }
});

// ── Announcements ─────────────────────────────────────────────────────────────

app.get('/api/announcements', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.name as author_name
    FROM announcements a LEFT JOIN users u ON a.created_by = u.id
    WHERE a.is_active = 1 ORDER BY a.created_at DESC`).all();
  res.json(rows);
});

app.get('/api/announcements/all', requireManager, (req, res) => {
  const rows = db.prepare(`SELECT a.*, u.name as author_name
    FROM announcements a LEFT JOIN users u ON a.created_by = u.id
    ORDER BY a.created_at DESC`).all();
  res.json(rows);
});

app.post('/api/announcements', requireManager, (req, res) => {
  const { title, message } = req.body;
  if (!title || !message) return res.status(400).json({ error: 'title and message required' });
  const result = db.prepare(`INSERT INTO announcements (title, message, created_by) VALUES (?,?,?)`)
    .run(title.trim(), message.trim(), req.session.userId);
  res.status(201).json({ id: result.lastInsertRowid });
});

app.patch('/api/announcements/:id/toggle', requireManager, (req, res) => {
  const row = db.prepare('SELECT id, is_active FROM announcements WHERE id=?').get(req.params.id) as any;
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE announcements SET is_active=? WHERE id=?').run(row.is_active ? 0 : 1, row.id);
  res.json({ ok: true, is_active: !row.is_active });
});

app.delete('/api/announcements/:id', requireManager, (req, res) => {
  const result = db.prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── Recent Activity ───────────────────────────────────────────────────────────

app.get('/api/activity', requireManager, (req, res) => {
  const limit = Number(req.query.limit) || 30;
  const rows = db.prepare(`
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
    )
    ORDER BY ts DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

// ── Polls ─────────────────────────────────────────────────────────────────────

app.get('/api/polls', requireAuth, (req, res) => {
  const userId = req.session.userId!;
  const sessionUser = db.prepare('SELECT role, is_admin FROM users WHERE id=?').get(userId) as any;
  const isManager = sessionUser?.role === 'manager' || sessionUser?.is_admin;
  const polls = db.prepare(`
    SELECT p.*, u.name as author_name,
      (SELECT COUNT(*) FROM poll_responses WHERE poll_id = p.id) as response_count,
      (SELECT response FROM poll_responses WHERE poll_id = p.id AND user_id = ?) as my_response
    FROM polls p JOIN users u ON p.created_by = u.id
    ORDER BY p.created_at DESC
  `).all(userId) as any[];

  const result = polls.map(p => ({
    ...p,
    results: isManager ? db.prepare('SELECT response, COUNT(*) as n FROM poll_responses WHERE poll_id = ? GROUP BY response').all(p.id) : null,
    respondents: isManager ? db.prepare(`SELECT u.name, pr.response, pr.created_at FROM poll_responses pr JOIN users u ON pr.user_id = u.id WHERE pr.poll_id = ? ORDER BY pr.created_at DESC`).all(p.id) : null
  }));
  res.json(result);
});

app.post('/api/polls', requireManager, (req, res) => {
  const { question } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question required' });
  const r = db.prepare('INSERT INTO polls (question, created_by) VALUES (?,?)').run(question.trim(), req.session.userId);
  res.json({ id: r.lastInsertRowid });
});

app.patch('/api/polls/:id/toggle', requireManager, (req, res) => {
  const poll = db.prepare('SELECT * FROM polls WHERE id=?').get(req.params.id) as any;
  if (!poll) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE polls SET is_active=? WHERE id=?').run(poll.is_active ? 0 : 1, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/polls/:id', requireManager, (req, res) => {
  db.prepare('DELETE FROM polls WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/polls/:id/respond', requireAuth, (req, res) => {
  const { response } = req.body;
  const VALID = ['😊','😐','😟'];
  if (!VALID.includes(response)) return res.status(400).json({ error: 'Invalid response' });
  const user = (req as any).user;
  db.prepare('INSERT INTO poll_responses (poll_id, user_id, response) VALUES (?,?,?) ON CONFLICT(poll_id, user_id) DO UPDATE SET response=excluded.response, created_at=datetime("now")')
    .run(req.params.id, user.id, response);
  res.json({ ok: true });
});

// ── Temporary migration endpoint (remove after use) ───────────────────────────
app.post('/api/migrate', (req, res) => {
  if (req.headers['x-migrate-key'] !== process.env.MIGRATE_KEY) return res.status(403).json({ error: 'Forbidden' });
  const { users, goals, highlights, awards, user_skills, evaluations, announcements, polls } = req.body;
  try {
    db.transaction(() => {
      // Delete in reverse dependency order (children before parents)
      db.prepare('DELETE FROM poll_responses').run();
      db.prepare('DELETE FROM goal_comments').run();
      db.prepare('DELETE FROM polls').run();
      db.prepare('DELETE FROM awards').run();
      db.prepare('DELETE FROM user_skills').run();
      db.prepare('DELETE FROM evaluations').run();
      db.prepare('DELETE FROM highlights').run();
      db.prepare('DELETE FROM updates').run();
      db.prepare('DELETE FROM goals').run();
      db.prepare('DELETE FROM announcements').run();
      db.prepare('DELETE FROM users').run();

      // Insert in dependency order (parents before children)
      if (users?.length) {
        const ins = db.prepare('INSERT INTO users (id,name,email,password_hash,role,avatar_initials,created_at,job_title,department,joined_at,last_promotion_date,promotion_title,bio,is_admin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
        users.forEach((u: any) => ins.run(u.id,u.name,u.email,u.password_hash,u.role,u.avatar_initials,u.created_at,u.job_title,u.department,u.joined_at,u.last_promotion_date,u.promotion_title,u.bio,u.is_admin));
      }
      if (goals?.length) {
        const ins = db.prepare('INSERT INTO goals (id,title,description,type,assigned_to,progress,status,due_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        goals.forEach((g: any) => ins.run(g.id,g.title,g.description,g.type,g.assigned_to,g.progress,g.status,g.due_date,g.created_by,g.created_at));
      }
      if (highlights?.length) {
        const ins = db.prepare('INSERT INTO highlights (id,type,title,description,employee_id,month,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)');
        highlights.forEach((h: any) => ins.run(h.id,h.type,h.title,h.description,h.employee_id,h.month,h.created_by,h.created_at));
      }
      if (awards?.length) {
        const ins = db.prepare('INSERT INTO awards (id,title,description,awarded_to,awarded_at,created_by) VALUES (?,?,?,?,?,?)');
        awards.forEach((a: any) => ins.run(a.id,a.title,a.description,a.awarded_to,a.awarded_at,a.created_by));
      }
      if (user_skills?.length) {
        const ins = db.prepare('INSERT INTO user_skills (id,user_id,skill,level,created_at) VALUES (?,?,?,?,?)');
        user_skills.forEach((s: any) => ins.run(s.id,s.user_id,s.skill,s.level,s.created_at));
      }
      if (evaluations?.length) {
        const ins = db.prepare('INSERT INTO evaluations (id,evaluatee_id,evaluator_id,eval_type,year,period,params,net_rating,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
        evaluations.forEach((e: any) => ins.run(e.id,e.evaluatee_id,e.evaluator_id,e.eval_type,e.year,e.period,e.params,e.net_rating,e.notes,e.created_at));
      }
      if (announcements?.length) {
        const ins = db.prepare('INSERT INTO announcements (id,title,message,created_by,created_at) VALUES (?,?,?,?,?)');
        announcements.forEach((a: any) => ins.run(a.id,a.title,a.message,a.created_by,a.created_at));
      }
      if (polls?.length) {
        const ins = db.prepare('INSERT INTO polls (id,question,created_by,is_active,created_at) VALUES (?,?,?,?,?)');
        polls.forEach((p: any) => ins.run(p.id,p.question,p.created_by,p.is_active,p.created_at));
      }
    })();
    res.json({ ok: true });
  } catch(e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Team Dashboard running on port ${PORT}`));
