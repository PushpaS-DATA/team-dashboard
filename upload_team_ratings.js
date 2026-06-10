const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const bcrypt = require('bcryptjs');

const db = new Database('team.db');

// Parse Excel
const wb = XLSX.readFile('/Users/pushpa/Library/CloudStorage/OneDrive-PENGUININTERNATIONAL/Team rating.xlsx');
const ws = wb.Sheets[wb.SheetNames[0]];
const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });

// Row 0 is column-label row — skip it, use rows 1-32
const dataRows = raw.slice(1);

const year = 2026;
const evalType = 'member';

// Find the manager (created_by)
const manager = db.prepare("SELECT id FROM users WHERE role = 'manager' LIMIT 1").get();
const createdBy = manager ? manager.id : 1;

// Upsert statement for evaluations (with new columns)
const upsertEval = db.prepare(`
  INSERT INTO evaluations
    (user_id, year, eval_type, complexity_of_work, avg_feedback_rating,
     attitude_towards_work, communication, learning_curve, engagement,
     net_rating, comments, area_of_improvement, created_by)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(user_id, year) DO UPDATE SET
    eval_type=excluded.eval_type,
    complexity_of_work=excluded.complexity_of_work,
    avg_feedback_rating=excluded.avg_feedback_rating,
    attitude_towards_work=excluded.attitude_towards_work,
    communication=excluded.communication,
    learning_curve=excluded.learning_curve,
    engagement=excluded.engagement,
    net_rating=excluded.net_rating,
    comments=excluded.comments,
    area_of_improvement=excluded.area_of_improvement,
    created_by=excluded.created_by
`);

const insertUser = db.prepare(`
  INSERT OR IGNORE INTO users (name, email, password_hash, role, avatar_initials)
  VALUES (?, ?, ?, 'employee', ?)
`);

const findUser = db.prepare(`SELECT id FROM users WHERE lower(name) LIKE ?`);

const hash = bcrypt.hashSync('Penguin@123', 10);

let created = 0, skipped = 0, rated = 0, errors = [];

const txn = db.transaction(() => {
  for (const row of dataRows) {
    const name = String(row['TEAM MEMBERS (32)'] || '').trim();
    if (!name || name === 'Name') continue;

    const n = v => (v !== '' && v != null) ? parseFloat(v) : null;

    // Find or create user
    let user = findUser.get('%' + name.toLowerCase() + '%');
    if (!user) {
      // create user
      const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().substring(0, 2);
      const email = name.toLowerCase().replace(/[^a-z0-9]/g, '.') + '@team.com';
      insertUser.run(name, email, hash, initials);
      user = findUser.get('%' + name.toLowerCase() + '%');
      created++;
    }

    if (!user) { errors.push('Could not find/create: ' + name); skipped++; continue; }

    upsertEval.run(
      user.id, year, evalType,
      n(row['__EMPTY']),   // complexity_of_work
      n(row['__EMPTY_1']), // avg_feedback_rating
      n(row['__EMPTY_2']), // attitude_towards_work
      n(row['__EMPTY_3']), // communication
      n(row['__EMPTY_4']), // learning_curve
      n(row['__EMPTY_5']), // engagement
      n(row['__EMPTY_6']), // net_rating
      row['__EMPTY_7'] || null, // comments (Strengths)
      row['__EMPTY_8'] || null, // area_of_improvement
      createdBy
    );
    rated++;
    console.log('✓', name, '— Net:', row['__EMPTY_6']);
  }
});

txn();

console.log('\n=== Done ===');
console.log('Users created:', created);
console.log('Evaluations uploaded:', rated);
console.log('Skipped:', skipped);
if (errors.length) console.log('Errors:', errors);

db.close();
