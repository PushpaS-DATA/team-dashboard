const fs = require('fs');
let code = fs.readFileSync('public/app.js', 'utf8');

const start = code.indexOf('    // ── Member cards ───────────────────────────────────────────────────────');
const end   = code.indexOf('  root.innerHTML = html;\n}', start);

const replacement = `    // ── Sortable searchable table ──────────────────────────────────────────
    const tableId = 'tr-table-' + yr;
    html += '<div class="tr-table-controls">' +
      '<div class="search-wrap" style="max-width:280px">' +
        '<svg class="search-icon" viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>' +
        '<input type="text" placeholder="Search by name…" oninput="filterRatingTable(\'' + tableId + '\', this.value)" />' +
      '</div>' +
      '<div class="tr-sort-btns">' +
        '<span style="font-size:12px;color:var(--text-muted)">Sort:</span>' +
        '<button class="tr-sort-btn active" onclick="sortRatingTable(\'' + tableId + '\',\'net_rating\',\'desc\',this)">Highest ↓</button>' +
        '<button class="tr-sort-btn" onclick="sortRatingTable(\'' + tableId + '\',\'net_rating\',\'asc\',this)">Lowest ↑</button>' +
        '<button class="tr-sort-btn" onclick="sortRatingTable(\'' + tableId + '\',\'name\',\'asc\',this)">A → Z</button>' +
        '<button class="tr-sort-btn" onclick="sortRatingTable(\'' + tableId + '\',\'name\',\'desc\',this)">Z → A</button>' +
      '</div>' +
    '</div>';

    html += '<div class="tr-table-wrap"><table class="tr-table" id="' + tableId + '"><thead><tr>' +
      '<th style="width:36px">#</th>' +
      '<th class="tr-th-left">Name</th>' +
      '<th class="tr-th-left">Job Title</th>' +
      '<th class="tr-th-left">TL</th>' +
      '<th class="tr-th-left" style="min-width:120px">Type of Work</th>' +
      SCORE_COLS.map(c => '<th title="' + c.label.replace('\\n',' ') + ' — ' + c.weight + '%">' + c.label.replace('\\n','<br>') + '<br><span class="tr-weight">' + c.weight + '%</span></th>').join('') +
      '<th style="min-width:90px">Net Rating</th>' +
      '<th class="tr-th-left" style="min-width:160px">Comments</th>' +
    '</tr></thead><tbody>' +
    sorted.map(function(m, idx) {
      const net = m.net_rating;
      return '<tr class="tr-row" data-name="' + m.member_name.toLowerCase() + '" data-net="' + (net||0) + '" onclick="openProfile(' + m.user_id + ')">' +
        '<td style="text-align:center;font-size:16px">' + rankMedal(idx) + '</td>' +
        '<td><div style="display:flex;align-items:center;gap:8px;white-space:nowrap">' +
          '<div class="avatar" style="width:30px;height:30px;font-size:10px;flex-shrink:0">' + (m.avatar_initials||m.member_name[0]) + '</div>' +
          '<span style="font-weight:600">' + m.member_name + '</span></div></td>' +
        '<td class="tr-td-muted">' + (m.job_title||'—') + '</td>' +
        '<td class="tr-td-muted">' + (m.tl_name||'—') + '</td>' +
        '<td class="tr-td-muted" style="font-size:11px">' + (m.type_of_work||'—') + '</td>' +
        SCORE_COLS.map(function(c) {
          const val = m[c.key];
          const bg  = val >= 8 ? '#d1fae5' : val >= 6 ? '#fef3c7' : val != null ? '#fee2e2' : '#f3f4f6';
          const col = val >= 8 ? '#065f46' : val >= 6 ? '#92400e' : val != null ? '#991b1b' : '#9ca3af';
          return '<td style="text-align:center"><span class="tr-score-badge" style="background:' + bg + ';color:' + col + '">' + (val != null ? val : '—') + '</span></td>';
        }).join('') +
        '<td style="text-align:center"><span class="tr-net-chip" style="background:' + netBg(net||0) + ';color:' + netColor(net||0) + '">' + (net != null ? net.toFixed(2) : '—') + '</span></td>' +
        '<td class="tr-td-muted" style="font-size:11px">' + (m.comments ? m.comments.substring(0,80) + (m.comments.length>80?'…':'') : '—') + '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div></div>';

  `;

code = code.substring(0, start) + replacement + '\n  ' + code.substring(end);
fs.writeFileSync('public/app.js', code);
console.log('Patch applied OK. start=' + start + ' end=' + end);
