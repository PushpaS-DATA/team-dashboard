// Run: DATABASE_URL="your-supabase-url" node migrate-billable.js
const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('Set DATABASE_URL env var'); process.exit(1); }

const pool = new Pool({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });

function excelDateToISO(serial) {
  if (!serial || typeof serial !== 'number') return null;
  const d = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return d.toISOString().slice(0, 10);
}

function normalizeStatus(s) {
  if (!s) return null;
  const m = s.toString().trim().toUpperCase();
  if (m === 'DEL' || m === 'DELIVERED') return 'Delivered';
  if (m === 'WIP') return 'Ongoing';
  if (m === 'HOLD' || m === 'HOLD') return 'On Hold';
  if (m === 'SCOPE') return 'Scope';
  if (m === 'PILOT') return 'Pilot';
  return s.toString().trim();
}

async function run() {
  const client = await pool.connect();
  try {
    const file = '/Users/pushpa/Library/CloudStorage/OneDrive-PENGUININTERNATIONAL/Billable data jan-sep.xlsx';
    const wb = XLSX.readFile(file);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
    const data = rows.slice(1).filter(r => r.length > 3);

    console.log(`Read ${data.length} rows from Excel`);

    // Remove unique constraint on case_code if it exists
    await client.query(`ALTER TABLE billable_records DROP CONSTRAINT IF EXISTS billable_records_case_code_key`);
    console.log('Dropped unique constraint on case_code');

    // Clear existing data
    const { rowCount } = await client.query('DELETE FROM billable_records');
    console.log(`Cleared ${rowCount} existing records`);

    // Insert new rows in batches
    let inserted = 0, skipped = 0;
    const BATCH = 100;
    for (let i = 0; i < data.length; i += BATCH) {
      const batch = data.slice(i, i + BATCH);
      for (const [j, r] of batch.entries()) {
        const rowIdx = i + j;
        try {
          const month   = r[0];        // Month number
          const year    = r[1];        // Year
          const dateSerial = r[2];     // Excel date serial
          const company = r[3];        // Co. Name
          const member  = r[4];        // Name (team member)
          const caseCode = r[5] ? r[5].toString().trim() : `AUTO-${rowIdx}`;
          const sector  = r[6];        // Sector
          const pm      = r[7];        // PM
          const useCase = r[8];        // Use Case
          const subUse  = r[9];        // Sub-Use Case
          const project = r[10];       // Project Name
          const hrs     = r[11] != null ? parseFloat(r[11]) : null;
          const rate    = r[12] != null ? parseFloat(r[12]) : null;
          const status  = normalizeStatus(r[13]);
          const dayNight = r[14];      // Day/Night

          const date = typeof dateSerial === 'number' ? excelDateToISO(dateSerial)
            : (year && month) ? `${year}-${String(month).padStart(2,'0')}-01` : null;

          const total = (hrs != null && rate != null) ? Math.round(hrs * rate) : null;

          const dayNightVal = r[14] ? r[14].toString().trim() : null;
          await client.query(
            `INSERT INTO billable_records
              (case_code, date, company_name, team_members, industry, pm_name,
               primary_category, secondary_category, project_name, billable_hours,
               charge_rate, total_amount, project_status, verified_payment, day_night)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [caseCode, date, company, member, sector, pm,
             useCase, subUse, project, hrs, rate, total, status, null, dayNightVal]
          );
          inserted++;
        } catch (e) {
          console.warn(`Row ${rowIdx} skipped:`, e.message);
          skipped++;
        }
      }
      process.stdout.write(`\rInserted ${inserted}/${data.length}...`);
    }

    console.log(`\nDone: ${inserted} inserted, ${skipped} skipped`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error(e); process.exit(1); });
