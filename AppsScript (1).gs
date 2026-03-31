/**
 * Leon Coach League — Apps Script Backend API
 * 
 * SETUP:
 * 1. Open your Google Sheet → Extensions → Apps Script
 * 2. Paste this entire file replacing everything
 * 3. Click Deploy → New deployment → Web app
 * 4. Execute as: Me | Who has access: Anyone
 * 5. Copy the deployment URL → paste in your index.html as APPS_SCRIPT_URL
 * 
 * ENDPOINTS (all via POST with JSON body):
 * - action: "login"           → { player, password }
 * - action: "change_password"  → { player, old_password, new_password }
 * - action: "daily_login"      → { player }
 * - action: "get_battlepass"   → { player }
 * - action: "get_inventory"    → { player }
 * - action: "check_account"    → { player }  (check if account exists, no auth needed)
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const action = data.action;
    
    switch(action) {
      case 'login':           return jsonResponse(handleLogin(data));
      case 'change_password': return jsonResponse(handleChangePassword(data));
      case 'daily_login':     return jsonResponse(handleDailyLogin(data));
      case 'get_battlepass':  return jsonResponse(handleGetBattlePass(data));
      case 'get_inventory':   return jsonResponse(handleGetInventory(data));
      case 'check_account':   return jsonResponse(handleCheckAccount(data));
      default: return jsonResponse({ ok: false, error: 'Unknown action' });
    }
  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function doGet(e) {
  return jsonResponse({ ok: true, message: 'Leon Coach League API v32' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── HELPERS ──

function hashPassword(password, salt) {
  const raw = salt + password;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return digest.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('');
}

function generateSalt() {
  const chars = 'abcdef0123456789';
  let salt = '';
  for (let i = 0; i < 32; i++) salt += chars.charAt(Math.floor(Math.random() * chars.length));
  return salt;
}

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function findAccountRow(playerName) {
  const ws = getSheet('Accounts');
  if (!ws) return null;
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === playerName.toLowerCase()) {
      return { row: i + 1, data: data[i] };
    }
  }
  return null;
}

// ── HANDLERS ──

function handleCheckAccount(data) {
  const player = (data.player || '').trim();
  if (!player) return { ok: false, error: 'Player name required' };
  const acc = findAccountRow(player);
  if (!acc) return { ok: true, exists: false };
  return { 
    ok: true, 
    exists: true, 
    level: acc.data[7] || 1,
    status: acc.data[9] || 'active'
  };
}

function handleLogin(data) {
  const player = (data.player || '').trim();
  const password = data.password || '';
  if (!player || !password) return { ok: false, error: 'Player and password required' };
  
  const acc = findAccountRow(player);
  if (!acc) return { ok: false, error: 'Account not found' };
  
  if (String(acc.data[9]).toLowerCase() === 'banned') {
    return { ok: false, error: 'Account is banned' };
  }
  
  const storedHash = acc.data[3];
  const salt = acc.data[4];
  const inputHash = hashPassword(password, salt);
  
  if (inputHash !== storedHash) return { ok: false, error: 'Wrong password' };
  
  // Update last login
  const ws = getSheet('Accounts');
  const now = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd HH:mm');
  ws.getRange(acc.row, 7).setValue(now);
  
  return { 
    ok: true, 
    player: acc.data[0],
    discord_tag: acc.data[2],
    level: acc.data[7] || 1,
    total_xp: acc.data[8] || 0
  };
}

function handleChangePassword(data) {
  const player = (data.player || '').trim();
  const oldPass = data.old_password || '';
  const newPass = data.new_password || '';
  if (!player || !oldPass || !newPass) return { ok: false, error: 'All fields required' };
  if (newPass.length < 4) return { ok: false, error: 'New password must be at least 4 characters' };
  
  const acc = findAccountRow(player);
  if (!acc) return { ok: false, error: 'Account not found' };
  
  // Verify old password
  const oldHash = hashPassword(oldPass, acc.data[4]);
  if (oldHash !== acc.data[3]) return { ok: false, error: 'Current password is wrong' };
  
  // Set new password with new salt
  const newSalt = generateSalt();
  const newHash = hashPassword(newPass, newSalt);
  const ws = getSheet('Accounts');
  ws.getRange(acc.row, 4).setValue(newHash);
  ws.getRange(acc.row, 5).setValue(newSalt);
  
  return { ok: true, message: 'Password changed' };
}

function handleDailyLogin(data) {
  const player = (data.player || '').trim();
  if (!player) return { ok: false, error: 'Player required' };
  
  const acc = findAccountRow(player);
  if (!acc) return { ok: false, error: 'Account not found' };
  
  // Check if already logged in today
  const lastLogin = String(acc.data[6] || '');
  const today = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd');
  if (lastLogin.startsWith(today)) {
    return { ok: true, already_claimed: true, xp_awarded: 0 };
  }
  
  // Award daily XP
  const xpConfig = getSheet('XPConfig');
  let dailyXP = 5;
  if (xpConfig) {
    const xpData = xpConfig.getDataRange().getValues();
    for (let i = 1; i < xpData.length; i++) {
      if (xpData[i][0] === 'daily_login') { dailyXP = Number(xpData[i][1]) || 5; break; }
    }
  }
  
  // Update account XP
  const ws = getSheet('Accounts');
  const oldXP = Number(acc.data[8]) || 0;
  const newXP = oldXP + dailyXP;
  const xpPerLevel = getConfigValue('bp_xp_per_level', 100);
  const newLevel = Math.floor(newXP / xpPerLevel) + 1;
  const now = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd HH:mm');
  
  ws.getRange(acc.row, 7).setValue(now);   // LastLogin
  ws.getRange(acc.row, 8).setValue(newLevel); // AccountLevel
  ws.getRange(acc.row, 9).setValue(newXP);    // TotalXP
  
  // Update PlayerBattlePass
  updateBattlePassXP(player, dailyXP);
  
  return { ok: true, already_claimed: false, xp_awarded: dailyXP, total_xp: newXP, level: newLevel };
}

function handleGetBattlePass(data) {
  const player = (data.player || '').trim();
  if (!player) return { ok: false, error: 'Player required' };
  
  const season = getConfigValue('bp_season', 'S1');
  const xpPerLevel = Number(getConfigValue('bp_xp_per_level', 100));
  
  // Get player BP progress
  const bpSheet = getSheet('PlayerBattlePass');
  let currentXP = 0, currentLevel = 1;
  if (bpSheet) {
    const bpData = bpSheet.getDataRange().getValues();
    for (let i = 1; i < bpData.length; i++) {
      if (String(bpData[i][0]).toLowerCase() === player.toLowerCase() && bpData[i][1] === season) {
        currentXP = Number(bpData[i][2]) || 0;
        currentLevel = Number(bpData[i][3]) || 1;
        break;
      }
    }
  }
  
  // Get season info
  const seasonsSheet = getSheet('BattlePassSeasons');
  let seasonName = '', maxLevel = 50, startDate = '', endDate = '';
  if (seasonsSheet) {
    const sData = seasonsSheet.getDataRange().getValues();
    for (let i = 1; i < sData.length; i++) {
      if (sData[i][0] === season) {
        seasonName = sData[i][1]; startDate = sData[i][2]; endDate = sData[i][3];
        maxLevel = Number(sData[i][4]) || 50; break;
      }
    }
  }
  
  // Get rewards
  const rewardsSheet = getSheet('BattlePassRewards');
  const rewards = [];
  if (rewardsSheet) {
    const rData = rewardsSheet.getDataRange().getValues();
    for (let i = 1; i < rData.length; i++) {
      if (rData[i][0] === season) {
        rewards.push({
          level: Number(rData[i][1]),
          type: rData[i][2],
          name: rData[i][3],
          image: rData[i][4],
          premium: rData[i][5],
          unlocked: currentLevel >= Number(rData[i][1])
        });
      }
    }
  }
  
  const xpForNextLevel = currentLevel * xpPerLevel;
  const xpInCurrentLevel = currentXP - ((currentLevel - 1) * xpPerLevel);
  
  return {
    ok: true,
    season: season,
    season_name: seasonName,
    start_date: startDate,
    end_date: endDate,
    max_level: maxLevel,
    current_level: currentLevel,
    current_xp: currentXP,
    xp_for_next: xpForNextLevel,
    xp_in_level: xpInCurrentLevel,
    xp_per_level: xpPerLevel,
    rewards: rewards
  };
}

function handleGetInventory(data) {
  const player = (data.player || '').trim();
  if (!player) return { ok: false, error: 'Player required' };
  
  const ws = getSheet('PlayerInventory');
  if (!ws) return { ok: true, items: [] };
  
  const allData = ws.getDataRange().getValues();
  const items = [];
  for (let i = 1; i < allData.length; i++) {
    if (String(allData[i][0]).toLowerCase() === player.toLowerCase()) {
      items.push({
        item_id: allData[i][1],
        type: allData[i][2],
        name: allData[i][3],
        unlocked_date: allData[i][4],
        equipped: String(allData[i][5]).toLowerCase() === 'true'
      });
    }
  }
  
  return { ok: true, items: items };
}

// ── UTILITY ──

function getConfigValue(key, defaultVal) {
  const ws = getSheet('AdminConfig');
  if (!ws) return defaultVal;
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) return data[i][1] || defaultVal;
  }
  return defaultVal;
}

function updateBattlePassXP(playerName, xpAmount) {
  const season = getConfigValue('bp_season', 'S1');
  const xpPerLevel = Number(getConfigValue('bp_xp_per_level', 100));
  const ws = getSheet('PlayerBattlePass');
  if (!ws) return;
  
  const data = ws.getDataRange().getValues();
  let targetRow = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).toLowerCase() === playerName.toLowerCase() && data[i][1] === season) {
      targetRow = i + 1; break;
    }
  }
  
  const now = Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd HH:mm');
  
  if (targetRow > 0) {
    const oldXP = Number(data[targetRow - 1][2]) || 0;
    const newXP = oldXP + xpAmount;
    const newLevel = Math.floor(newXP / xpPerLevel) + 1;
    ws.getRange(targetRow, 3).setValue(newXP);
    ws.getRange(targetRow, 4).setValue(newLevel);
    ws.getRange(targetRow, 6).setValue(now);
  } else {
    const newLevel = Math.floor(xpAmount / xpPerLevel) + 1;
    ws.appendRow([playerName, season, xpAmount, newLevel, '[]', now]);
  }
}
