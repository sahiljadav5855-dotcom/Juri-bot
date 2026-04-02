require('dotenv').config();

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();

const PREFIX = '.';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  allowedMentions: {
    parse: ['users', 'roles'], // still allow normal mentions
    repliedUser: false         // 🚫 disables reply ping globally
  }
});

const db = new sqlite3.Database('./cards.db');
const filteredCodesMap = new Map(); // store codes for "Copy All Codes" buttons
const invStateMap = new Map();
const evolveMap = new Map();
const reminderUsers = new Map(); // userId -> { channelId, enabled }
const searchStateMap = new Map();

db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
});
let dbReady = false;

db.configure('busyTimeout', 5000);

// ✅ WAL MODE (Step 1)
db.serialize(() => {
  db.run("PRAGMA journal_mode = WAL;");
  db.run("PRAGMA synchronous = NORMAL;");
});

// ✅ STEP 2 — SAFE DB HELPERS
function runQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(query, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  });
}

function getQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allQuery(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function sendReminder(userId, messageText, delay) {
  if (!reminderUsers.has(userId)) return;

  const chId = reminderUsers.get(userId);

  setTimeout(async () => {
    try {
      const channel = await client.channels.fetch(chId);

      channel.send({
        content: `<@${userId}> ${messageText}`, // ✅ ONLY place we ping
        allowedMentions: { users: [userId] }
      });

    } catch (err) {
      console.log("Reminder failed:", err.message);
    }
  }, delay);
}

// Cooldowns
const dropCooldowns = new Map();
const workCooldowns = new Map();

function checkCooldown(map, userId, cooldown, type = null) {
  const now = Date.now();

  if (map.has(userId)) {
    const exp = map.get(userId) + cooldown;
    if (now < exp) return ((exp - now) / 1000).toFixed(1);
  }

  map.set(userId, now);
}

const DROP_CD = 15000;
const WORK_CD = 15000;

// Init DB
db.serialize(() => {

  // 👤 USERS
  db.run(`CREATE TABLE IF NOT EXISTS users (
  userId TEXT PRIMARY KEY,
  coins INTEGER DEFAULT 0,
  description TEXT DEFAULT '',
  normalPack INTEGER DEFAULT 0,
  specialPack INTEGER DEFAULT 0,
  universalPack INTEGER DEFAULT 0
)`);

  // 📝 PENDING
  db.run(`CREATE TABLE IF NOT EXISTS pending_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    groupName TEXT,
    era TEXT,
    stars INTEGER,
    image TEXT,
    creatorId TEXT
  )`);

  // ✅ APPROVED
  db.run(`CREATE TABLE IF NOT EXISTS approved_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    groupName TEXT,
    era TEXT,
    stars INTEGER,
    image TEXT,
    creatorId TEXT
  )`);

  // 🎮 GAME CARDS (🔥 REQUIRED)
  db.run(`CREATE TABLE IF NOT EXISTS game_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    groupName TEXT,
    era TEXT,
    stars INTEGER,
    image TEXT,
    creatorId TEXT
  )`);

  db.run(`ALTER TABLE cards ADD COLUMN stars INTEGER`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE cards ADD COLUMN groupName TEXT`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

  // 🎴 INVENTORY (FINAL CORRECT VERSION)
  db.run(`CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId TEXT,
    cardName TEXT,
    era TEXT,
    code TEXT UNIQUE,
    createdAt INTEGER,
    copyNumber INTEGER
  )`, (err) => {
    if (err) console.error(err);
    else {
      console.log("✅ Database ready");
      dbReady = true;
    }
  });

  // 🧠 SAFE MIGRATION (only if needed)
  db.run(`ALTER TABLE cards ADD COLUMN copyNumber INTEGER`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err);
    }
  });

  db.run(`ALTER TABLE users ADD COLUMN normalPacks INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE users ADD COLUMN specialPacks INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE users ADD COLUMN universalPacks INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE users ADD COLUMN dailyStreak INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE users ADD COLUMN lastDaily INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE users ADD COLUMN lastMysteryGift INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

// 🛒 MARKETPLACE COLUMNS (FIX)
db.run(`ALTER TABLE cards ADD COLUMN listed INTEGER DEFAULT 0`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

db.run(`ALTER TABLE cards ADD COLUMN price INTEGER`, (err) => {
  if (err && !err.message.includes("duplicate column")) console.error(err);
});

});

// Replace with creator role IDS
const ROLE_A = "1486687059220365312"; // card creators
const ROLE_B = "1486687236706537583"; // card approvers
const ROLE_MUR = "1487418015376080977"; // 🔥 master user role
const BOT_ID = "1285564711437340712";

// Helpers
const STAR = "<:JuriStar:1486330010326269972>";
const COIN = "<:JuriBucks:1486332345194909717>";

async function isBanned(userId) {
  const row = await getQuery(
    `SELECT banned FROM users WHERE userId=?`,
    [userId]
  );
  return row?.banned == 1;
}

function getStars(count) {
  return STAR.repeat(count);
}

function generateCode(card) {
  const first = card.name[0] || 'x';
  const second = card.group[0] || 'x';
  const third = card.era[0] || 'x';

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789!@#$%^&';

  let randomPart = '';
  for (let i = 0; i < 3; i++) {
    randomPart += chars[Math.floor(Math.random() * chars.length)];
  }

  return `${first}${second}${third}${randomPart}`.toLowerCase();
}

async function generateUniqueCode(card) {
  let code;
  let exists = true;

  while (exists) {
    code = generateCode(card);

    const row = await getQuery(
      `SELECT code FROM cards WHERE code = ?`,
      [code]
    );

    if (!row) exists = false;
  }

  return code;
}

// 👤 Resolve user from mention OR ID
async function resolveUser(message, arg) {
  // mention
  if (message.mentions.users.first()) {
    return message.mentions.users.first();
  }

  // ID
  if (arg) {
    try {
      return await client.users.fetch(arg);
    } catch {
      return null;
    }
  }

  return null;
}

function rollPackRarity(type, threeStarCount) {
  const rand = Math.random();

  if (type === 'normal') {
    if (threeStarCount >= 1) {
      if (rand < 0.045) return 2;
      return 1;
    }
    if (rand < 0.005) return 3;
    if (rand < 0.05) return 2;
    return 1;
  }

  if (type === 'special') {
    if (threeStarCount >= 1) {
      if (rand < 0.60) return 2;
      return 1;
    }
    if (rand < 0.02) return 3;
    if (rand < 0.62) return 2;
    return 1;
  }

  if (type === 'universal') {
    if (threeStarCount >= 2) {
      return 2;
    }
    if (rand < 0.40) return 3;
    return 2;
  }

  return 1;
}

// Ready
client.once('clientReady', async () => {
  console.log('✅ Bot started');

  try {
    const count = await getQuery(`SELECT COUNT(*) as total FROM game_cards`);
    console.log(`✅ ${count.total} cards available in game database`);
  } catch (err) {
    console.error("❌ Failed to check cards:", err);
  }
});

// Commands
client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!dbReady) return message.reply("⏳ Bot starting...");


const content = message.content.toLowerCase().trim();

  // 🚫 ONLY CHECK BAN IF IT'S A COMMAND
  if (content.startsWith('.')) {

    const userData = await getQuery(
      `SELECT banned FROM users WHERE userId=?`,
      [message.author.id]
    );

    if (userData?.banned == 1) {
      return message.reply("🚫 You are banned from using this bot.");
    }
  }

  // 🎁 RANDOM MYSTERY GIFT SYSTEM
if (!dbReady) return;

(async () => {

  const userId = message.author.id;

  // 🎲 RANDOM CHANCE (5%)
  if (Math.random() > 0.05) return;

  const user = await getQuery(
    `SELECT lastMysteryGift FROM users WHERE userId=?`,
    [userId]
  );

  const now = Date.now();
  const cooldown = 14 * 24 * 60 * 60 * 1000;

  if (user?.lastMysteryGift && now - user.lastMysteryGift < cooldown) {
    return;
  }

  const botId = client.user.id;

  const getCards = async (stars) => {
    return await allQuery(
      `SELECT * FROM cards WHERE userId=? AND stars=?`,
      [botId, stars]
    );
  };

  const pick = (arr, n) => arr.sort(() => 0.5 - Math.random()).slice(0, n);

  let results = [];

  // ⭐ 3★
  let three = await getCards(3);
  if (three.length) results.push(...pick(three, 1));

  // ⭐ 2★
  let two = await getCards(2);
  if (two.length) results.push(...pick(two, Math.min(2, two.length)));

  // ⭐ 1★
  let one = await getCards(1);
  if (one.length) results.push(...pick(one, Math.min(2, one.length)));

  if (!results.length) return;

  // 🎁 TRANSFER
  for (const c of results) {
    await runQuery(
      `UPDATE cards SET userId=? WHERE code=?`,
      [userId, c.code]
    );
  }

  // ⏱ SAVE COOLDOWN
  await runQuery(
    `UPDATE users SET lastMysteryGift=? WHERE userId=?`,
    [now, userId]
  );

  message.channel.send(
    `🎁 Congrats <@${userId}> you got a **Mystery Gift!**\n\n` +
    results.map(c => `🎫 \`${c.code}\` (${c.stars}★)`).join('\n')
  );

})();

// 🎴 DROP (FINAL VERSION - DB BASED)
if (content.startsWith('.drop')) {
  // 🔔 UPDATE LAST CHANNEL
if (reminderUsers.has(message.author.id)) {
  reminderUsers.set(message.author.id, message.channel.id);
}
  const cd = checkCooldown(
  dropCooldowns,
  message.author.id,
  DROP_CD,
  'drop',
  message.channel.id
);
  if (cd) return message.reply(`⏳ Wait ${cd}s`);

  (async () => {
    try {

      // 🎯 GET RANDOM CARD FROM DB
      const allCards = await allQuery(`SELECT * FROM game_cards`);

      if (!allCards.length) {
        return message.reply("❌ No cards loaded in game!");
      }

      // 🎲 RANDOM SELECTION WITH RARITY
      const rand = Math.random();
      let pool;

      if (rand < 0.10) pool = allCards.filter(c => c.stars === 3);
      else if (rand < 0.35) pool = allCards.filter(c => c.stars === 2);
      else pool = allCards.filter(c => c.stars === 1);

      if (!pool.length) pool = allCards;

      const c = pool[Math.floor(Math.random() * pool.length)];

      // 🔑 UNIQUE CODE
      const code = await generateUniqueCode({
        name: c.name,
        group: c.groupName,
        era: c.era
      });

      // 🧬 COPY NUMBER SYSTEM
      const countRow = await getQuery(
        `SELECT COUNT(*) as total FROM cards WHERE LOWER(cardName)=LOWER(?) AND LOWER(era)=LOWER(?)`,
        [c.name, c.era]
      );

      const copyNumber = (countRow?.total || 0) + 1;

      // 💾 SAVE CARD
      await runQuery(
  `INSERT INTO cards (userId, cardName, era, code, createdAt, copyNumber, stars, groupName)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    message.author.id,
    c.name,
    c.era,
    code,
    Date.now(),
    copyNumber,
    c.stars,
    c.groupName
  ]
);

sendReminder(
  message.author.id,
  "🎴 your **drop** is ready again!",
  30 * 60 * 1000 // 30 min (or your cooldown)
);

      // 🎴 SHOW CARD
      message.reply({
        embeds: [{
          color: 0xff69b4,
          title: `${c.name} (${c.groupName}) [${c.era}] ${getStars(c.stars)}`,
          description: `Code: **${code}**`,
          image: { url: c.image }
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ DB error");
    }
  })();
}

  // 💼 WORK
if (content.startsWith('.work')) {
  // 🔔 UPDATE LAST CHANNEL
if (reminderUsers.has(message.author.id)) {
  reminderUsers.set(message.author.id, message.channel.id);
}
  const cd = checkCooldown(
  workCooldowns,
  message.author.id,
  WORK_CD,
  'work',
  message.channel.id
);
  if (cd) return message.reply(`⏳ Wait ${cd}s`);

  const earn = Math.floor(Math.random() * 21) + 10;

  (async () => {
    try {
      await runQuery(
        `INSERT OR IGNORE INTO users (userId, coins) VALUES (?, 0)`,
        [message.author.id]
      );

      await runQuery(
        `UPDATE users SET coins = coins + ? WHERE userId = ?`,
        [earn, message.author.id]
      );

      message.reply(`Congrats!! You earned +${earn} ${COIN} JuriBucks`);
    } catch (err) {
      console.error(err);
      message.reply("❌ DB error");
    }
  })();
  sendReminder(
  message.author.id,
  "🎴 your **drop** is ready again!",
  30 * 60 * 1000 // 30 min (or your cooldown)
);
}

//BALANCE
if (content.startsWith('.bal')) {
  db.get(`SELECT coins FROM users WHERE userId=?`,
    [message.author.id],
    (err, row) => {
      const coins = row ? row.coins : 0;
      message.reply(`${COIN} You have **${coins} JuriBucks**`);
    });
}

// ⏱ TIMER (UPDATED WITH DAILY)
if (content.startsWith('.t')) {
  (async () => {

    const now = Date.now();

    // 🔻 DROP
    let drop = "✅ Ready";
    if (dropCooldowns.has(message.author.id)) {
      const exp = dropCooldowns.get(message.author.id) + DROP_CD;
      if (now < exp) drop = `⏳ ${((exp - now)/1000).toFixed(1)}s`;
    }

    // 🔻 WORK
    let work = "✅ Ready";
    if (workCooldowns.has(message.author.id)) {
      const exp = workCooldowns.get(message.author.id) + WORK_CD;
      if (now < exp) work = `⏳ ${((exp - now)/1000).toFixed(1)}s`;
    }

    // 🔻 DAILY
    let daily = "✅ Ready";

    const user = await getQuery(
      `SELECT lastDaily FROM users WHERE userId=?`,
      [message.author.id]
    );

    if (user?.lastDaily) {
      const exp = user.lastDaily + (24 * 60 * 60 * 1000);
      if (now < exp) {
        daily = `⏳ ${((exp - now)/1000/60/60).toFixed(1)}h`;
      }
    }

    // 📤 RESPONSE
    message.reply(
`Drop: ${drop}
Work: ${work}
Daily: ${daily}`
    );

  })();
}

// 🧬 EVOLVE (FIXED SYSTEM)
if (content.startsWith('.evolve')) {
  (async () => {
    try {

      const codesInput = message.content.split(' ').slice(1).join(' ');

      if (!codesInput) {
        return message.reply("❌ Use: .evolve code1, code2, code3");
      }

      const codes = codesInput
        .split(',')
        .map(c => c.trim().toLowerCase())
        .filter(Boolean);

      if (codes.length < 3) {
        return message.reply("❌ You need at least 3 cards to evolve");
      }

      if (codes.length > 15) {
  return message.reply("❌ Max 15 cards per evolve");
}

      // 🔍 FETCH CARDS
      const placeholders = codes.map(() => '?').join(',');
      const rows = await allQuery(
        `SELECT * FROM cards WHERE LOWER(code) IN (${placeholders})`,
        codes
      );

      if (rows.length !== codes.length) {
        return message.reply("❌ Some cards not found");
      }

      // 🔒 OWNER CHECK
      if (rows.some(r => r.userId !== message.author.id)) {
        return message.reply("❌ You must own all cards");
      }

      // 🧠 BASE NAME CHECK
      const baseName = rows[0].cardName;

      if (!rows.every(r => r.cardName === baseName)) {
        return message.reply("❌ Cards must have same name");
      }

      // ⭐ SAME RARITY CHECK (NEW)
const baseStars = rows[0].stars || 1;

if (!rows.every(r => (r.stars || 1) === baseStars)) {
  return message.reply("❌ Use same rarity cards only!");
}

// 🚫 MAX STAR BLOCK (NEW)
if (baseStars >= 3) {
  return message.reply("❌ Max rarity reached. Cannot evolve further!");
}

// 🔢 MULTIPLE OF 3 CHECK (NEW)
const count = rows.length;

if (count % 3 !== 0) {
  return message.reply("❌ You must use multiples of 3 cards (3, 6, 9...)");
}

      // 🧠 GET BASE DATA
      const baseData = await getQuery(
        `SELECT * FROM game_cards WHERE LOWER(name)=LOWER(?)`,
        [baseName]
      );

      if (!baseData) {
        return message.reply("❌ Card data missing in game database");
      }

      const group = baseData.groupName;

      // 🔒 GROUP CHECK
      const validGroupCheck = await Promise.all(
        rows.map(r =>
          getQuery(
            `SELECT groupName FROM game_cards WHERE LOWER(name)=LOWER(?) AND LOWER(era)=LOWER(?)`,
            [r.cardName, r.era]
          )
        )
      );

      if (validGroupCheck.some(g => !g || g.groupName !== group)) {
        return message.reply("❌ Cards must be from same group");
      }

      // 🎲 ERA POOL
      const eraPool = rows.map(r => r.era);

      // 🎯 CONFIRM BUTTONS
      const rowBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`evolve_confirm_${message.author.id}`)
          .setLabel('Confirm')
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`evolve_cancel_${message.author.id}`)
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger)
      );

      const reply = await message.reply({
        embeds: [{
          color: 0x00ff99,
          title: "🧬 Confirm Evolution",
          description: `Evolving **${rows.length}x ${baseName} (${group})**\n\n⚠️ This cannot be undone`
        }],
        components: [rowBtn]
      });

      // 💾 STORE DATA
      evolveMap.set(reply.id, {
        userId: message.author.id,
        cards: rows,
        eraPool,
        baseName,
        group
      });

      setTimeout(() => evolveMap.delete(reply.id), 60000);

    } catch (err) {
      console.error(err);
      message.reply("❌ Evolution failed");
    }
  })();
}
  
// 🎁 GIFT CARD (FIXED)
if (content.startsWith('.gift')) {
  (async () => {
    try {

      const args = message.content.split(' ');

      const targetUser = await resolveUser(message, args[1]);
      const codesInput = args.slice(2).join(' ');

      // ✅ VALIDATION FIRST
      if (!targetUser) {
        return message.reply(`❌ Use: ${PREFIX}gift @user/id code1, code2`);
      }

      // ✅ BAN CHECK (SAFE NOW)
      const targetBan = await getQuery(
        `SELECT banned FROM users WHERE userId=?`,
        [targetUser.id]
      );

      if (targetBan?.banned == 1) {
        return message.reply("🚫 You cannot gift cards to this user (banned).");
      }

      if (!codesInput) {
        return message.reply(`❌ Provide at least 1 card code`);
      }

      if (targetUser.id === message.author.id) {
        return message.reply("❌ You can't gift yourself!");
      }

      // split codes
      const codes = codesInput
        .split(',')
        .map(c => c.trim().toLowerCase())
        .filter(Boolean);

      if (codes.length > 15) {
        return message.reply("❌ You can gift a maximum of 15 cards at once!");
      }

      let success = [];
      let failed = [];

      for (const code of codes) {

        const row = await getQuery(
          `SELECT * FROM cards WHERE userId = ? AND LOWER(code)=?`,
          [message.author.id, code]
        );

        if (!row) {
          failed.push(code);
          continue;
        }

        await runQuery(
          `UPDATE cards SET userId = ? WHERE id = ?`,
          [targetUser.id, row.id]
        );

        success.push(`${row.cardName} (${row.era}) - ${code}`);
      }

      return message.reply({
        embeds: [{
          color: 0xffa500,
          title: "🎁 Bulk Gift Complete",
          description: `Sent to **${targetUser.username}**`,
          fields: [
            {
              name: "✅ Success",
              value: success.length ? success.join(', ') : "None",
              inline: false
            },
            {
              name: "❌ Failed",
              value: failed.length ? failed.join(', ') : "None",
              inline: false
            }
          ]
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ Failed to gift cards!");
    }
  })();
}

// 💸 GIVE JURIBUCKS (FIXED)
if (content.startsWith('.give')) {

  (async () => {
    try {

      const args = message.content.split(' ');
      const targetUser = await resolveUser(message, args[1]);
      const amount = parseInt(args[2]);

      // ✅ VALIDATION FIRST
      if (!targetUser) {
        return message.reply(`❌ Use: ${PREFIX}give @user/id <amount>`);
      }

      // ✅ BAN CHECK (SAFE NOW)
      const targetBan = await getQuery(
        `SELECT banned FROM users WHERE userId=?`,
        [targetUser.id]
      );

      if (targetBan?.banned == 1) {
        return message.reply("🚫 You cannot send JuriBucks to this user (banned).");
      }

      if (!amount || amount <= 0) {
        return message.reply("❌ Enter a valid amount");
      }

      if (targetUser.id === message.author.id) {
        return message.reply("❌ You can't pay yourself!");
      }

      // Ensure sender exists
      await runQuery(
        `INSERT OR IGNORE INTO users (userId, coins) VALUES (?, 0)`,
        [message.author.id]
      );

      // Ensure receiver exists
      await runQuery(
        `INSERT OR IGNORE INTO users (userId, coins) VALUES (?, 0)`,
        [targetUser.id]
      );

      // Get sender balance
      const sender = await getQuery(
        `SELECT coins FROM users WHERE userId=?`,
        [message.author.id]
      );

      if (sender.coins < amount) {
        return message.reply(`❌ Not enough ${COIN} JuriBucks!`);
      }

      // 💸 Transfer
      await runQuery(
        `UPDATE users SET coins = coins - ? WHERE userId = ?`,
        [amount, message.author.id]
      );

      await runQuery(
        `UPDATE users SET coins = coins + ? WHERE userId = ?`,
        [amount, targetUser.id]
      );

      message.reply({
        embeds: [{
          color: 0x00cc66,
          title: "Payment Sent!",
          description: `✨ **${message.author.username}** sent **${amount} ${COIN}** to **${targetUser.username}**`
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ Payment failed!");
    }
  })();
}

// 👤 PROFILE (SELF / MENTION / ID)
if (content.startsWith('.p')) {
  (async () => {
    try {

      const args = message.content.split(' ').slice(1);

      let target = message.author;

      const resolved = await resolveUser(message, args[0]);
      if (resolved) target = resolved;
      else if (args[0]) return message.reply("❌ Invalid user");

      // 💰 Coins + Description
      const userData = await getQuery(
        `SELECT coins, description, normalPacks, specialPacks, universalPacks 
         FROM users WHERE userId=?`,
        [target.id]
      );

      // 🛠 FIX NULL VALUES
      const coins = userData?.coins || 0;
      const description = userData?.description || "No description set.";
      const normalPacks = userData?.normalPacks || 0;
      const specialPacks = userData?.specialPacks || 0;
      const universalPacks = userData?.universalPacks || 0;

      // 🎴 Cards
      const rows = await allQuery(
        `SELECT * FROM cards WHERE userId=?`,
        [target.id]
      );

      const total = rows.length;

      // 🚫 BAN CHECK (TARGET USER)
      const banData = await getQuery(
        `SELECT banned FROM users WHERE userId=?`,
        [target.id]
      );

      let banWarning = "";

      if (banData?.banned == 1) {
        banWarning =
          "\n\n⛔⛔⛔⛔ This user has been banned from this bot! ⛔⛔⛔⛔";
      }

      // 📊 EMBED
      return message.reply({
        embeds: [{
          color: 0x7289da,
          title: `👤 ${target.username}'s Profile`,
          fields: [
            {
              name: "📝 Description",
              value: description,
              inline: false
            },
            {
              name: `${COIN} JuriBucks`,
              value: `${coins}`,
              inline: true
            },
            {
              name: "🎴 Total Cards",
              value: `${total}`,
              inline: true
            },
            {
              name: "🎁 Packs",
              value:
`📦 Normal: **${normalPacks}**
✨ Special: **${specialPacks}**
🌌 Universal: **${universalPacks}**`,
              inline: false
            }
          ],
          description: banWarning || undefined
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ Failed to load profile");
    }
  })();
}

// 👁 VIEW CARD (OWNER ONLY + COPY SYSTEM)
if (content.startsWith('.view')) {
  (async () => {
    try {
      const args = message.content.split(' ').slice(1);
      const code = args[0]?.toLowerCase();

      if (!code) {
        return message.reply("❌ Use: .view <card code>");
      }

      // 🔍 Find card in inventory
      const row = await getQuery(
        `SELECT * FROM cards WHERE LOWER(code)=?`,
        [code]
      );

      if (!row) {
        return message.reply("❌ Card not found!");
      }

      // 🔒 OWNER ONLY
      if (row.userId !== message.author.id) {
        return message.reply("❌ You don't own this card!");
      }

      // 🔍 Get card data from DB
      const cardData = await getQuery(
  `SELECT * FROM game_cards 
   WHERE LOWER(name)=LOWER(?) 
   AND LOWER(era)=LOWER(?) 
   AND stars = ?`,
  [row.cardName, row.era, row.stars]
);

      const date = row.createdAt
        ? new Date(row.createdAt).toLocaleString()
        : "Unknown";

      const creator = cardData?.creatorId
        ? `<@${cardData.creatorId}>`
        : "System";

      // 🧬 COPY SYSTEM (HIDDEN TIERS)
      let copyText = "";

      if (row.copyNumber <= 10) {
        copyText = "One of the first 10 copies";
      } else if (row.copyNumber <= 25) {
        copyText = "One of the first 25 copies";
      } else if (row.copyNumber <= 100) {
        copyText = "One of the first 100 copies";
      }

      // 🎴 SHOW CARD
      message.reply({
        embeds: [{
          color: 0xff69b4,
          title: `${row.cardName} (${cardData?.groupName || "Unknown"})`,
          description: `Era: ${row.era}
Rarity: ${getStars(row.stars || 1)}
${copyText ? copyText + '\n' : ""}Obtained: ${date}
Creator: ${creator}`,
          image: { url: cardData?.image || "https://via.placeholder.com/300x400?text=No+Image" }
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ Failed to view card");
    }
  })();
}

// CCR Create Section (FIXED)
if (content.startsWith('.ccr create')) {
  (async () => {

    if (!message.member.roles.cache.has(ROLE_A)) {
      return message.reply("❌ You don't have permission to create cards");
    }

    const args = message.content.split('|');

    if (args.length < 5) {
      return message.reply("❌ Use: .ccr create name | group | era | stars | image");
    }

    const name = args[0].split(' ').slice(2).join(' ').trim();
    const group = args[1].trim();
    const era = args[2].trim();
    const stars = parseInt(args[3].trim());
    const image = args[4].trim();

    if (!name || !group || !era || !stars || !image) {
      return message.reply("❌ Invalid format");
    }

    // ✅ CORRECT TABLE + CORRECT DATA
    await runQuery(
      `INSERT INTO pending_cards (name, groupName, era, stars, image, creatorId)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, group, era, stars, image, message.author.id]
    );

    message.reply("✅ Card submitted for approval!");

  })();
}

//CCR Section
if (content.startsWith('.ccr')) {
  (async () => {

    const page = parseInt(message.content.split(' ')[1]) || 1;
    const limit = 15;
    const offset = (page - 1) * limit;

    const rows = await allQuery(
      `SELECT * FROM pending_cards LIMIT ? OFFSET ?`,
      [limit, offset]
    );

    if (!rows.length) return message.reply("📭 No pending cards");

    const embed = {
      title: `📋 Pending Cards (Page ${page})`,
      description: rows.map((c, i) =>
        `${i + 1}. ${c.name} (${c.groupName}) [${c.era}] ⭐${c.stars}\n👤 <@${c.creatorId}>`
      ).join('\n\n')
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`ccr_prev_${page}`)
        .setLabel('Prev')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`ccr_next_${page}`)
        .setLabel('Next')
        .setStyle(ButtonStyle.Primary)
    );

    await message.reply({ embeds: [embed], components: [row] });

  })();
}

//CCR Delete
if (content.startsWith('.ccr delete')) {
  (async () => {

    if (!message.member.roles.cache.has(ROLE_A)) {
      return message.reply("❌ No permission");
    }

    const index = parseInt(message.content.split(' ')[2]);
    if (!index) return message.reply("❌ Provide index");

    const rows = await allQuery(`SELECT * FROM pending_cards ORDER BY id ASC`);

    const card = rows[index - 1];
    if (!card) return message.reply("❌ Invalid index");

    await runQuery(`DELETE FROM pending_cards WHERE id=?`, [card.id]);

    message.reply(`🗑 Deleted card #${index}`);

  })();
}

//ACR Accept
if (content.startsWith('.acr accept')) {
  (async () => {

    if (!message.member.roles.cache.has(ROLE_B)) {
      return message.reply("❌ No permission");
    }

    const index = parseInt(message.content.split(' ')[2]);

    const rows = await allQuery(`SELECT * FROM pending_cards ORDER BY id ASC`);
    const card = rows[index - 1];

    if (!card) return message.reply("❌ Invalid index");

    await runQuery(
      `INSERT INTO approved_cards (name, groupName, era, stars, image, creatorId)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [card.name, card.groupName, card.era, card.stars, card.image, card.creatorId]
    );

    await runQuery(`DELETE FROM pending_cards WHERE id=?`, [card.id]);

    message.reply(`✅ Card approved and moved to pool`);

  })();
}

//ACR Delete
if (content.startsWith('.acr delete')) {
  (async () => {

    if (!message.member.roles.cache.has(ROLE_B)) {
      return message.reply("❌ No permission");
    }

    const index = parseInt(message.content.split(' ')[2]);

    const rows = await allQuery(`SELECT * FROM approved_cards ORDER BY id ASC`);
    const card = rows[index - 1];

    if (!card) return message.reply("❌ Invalid index");

    await runQuery(`DELETE FROM approved_cards WHERE id=?`, [card.id]);

    message.reply(`🗑 Deleted from approved pool`);

  })();
}

//acr list view
if (content.startsWith('.acr')) {
  (async () => {
    try {

      const args = message.content.split(' ');

      // 👉 DEFAULT = LIST
      if (!args[1] || args[1] === 'list') {

        const rows = await allQuery(
          `SELECT * FROM approved_cards ORDER BY id ASC`
        );

        if (!rows.length) {
          return message.reply("📭 No approved cards.");
        }

        const slice = rows.slice(0, 15);

        const embed = {
          color: 0x00ff99,
          title: "📦 Approved Cards",
          description: slice.map((c, i) => {
            return `${i + 1}. **${c.name}** (${c.groupName}) [${c.era}] ⭐${c.stars}
👤 <@${c.creatorId}>`;
          }).join('\n')
        };

        const row = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId('game_ready')
    .setLabel('GAME READY 🚀')
    .setStyle(ButtonStyle.Danger)
);

        return message.reply({
  embeds: [embed],
  components: [row]
});
      }

      //acr view 
            // 👁 VIEW APPROVED CARD
      if (args[1] === 'view') {

        const index = parseInt(args[2]);

        if (!index || index < 1) {
          return message.reply("❌ Use: .acr view <number>");
        }

        const rows = await allQuery(
          `SELECT * FROM approved_cards ORDER BY id ASC`
        );

        const card = rows[index - 1];

        if (!card) {
          return message.reply("❌ Card not found");
        }

        const date = new Date().toLocaleString();

        return message.reply({
          embeds: [{
            color: 0x00ff99,
            title: `${card.name} (${card.groupName})`,
            description: `Era: ${card.era}
Rarity: ${getStars(card.stars)}
Creator: <@${card.creatorId}>
Previewed: ${date}`,
            image: { url: card.image }
          }]
        });
      }

          } catch (err) {
      console.error(err);
      message.reply("❌ ACR error");
    }
  })();
}

// 🛒 SHOP SYSTEM (STORE PACKS INSTEAD OF OPENING)
if (content.startsWith('.shop')) {

  const args = content.split(' ');
  const sub = args[1];

  if (!sub) {
    return message.reply("❌ Use: .shop check OR .shop buy <normal/special/universal>");
  }

  // 🛒 CHECK SHOP
  if (sub === 'check') {
    return message.reply({
      embeds: [{
        color: 0xffcc00,
        title: "🛒 Card Packs",
        description:
`Normal Pack (100 ${COIN})
Special Pack (200 ${COIN})
Universal Pack (300 ${COIN})

Use: .shop buy normal/special/universal`
      }]
    });
  }

  // 🛍 BUY PACK
  if (sub === 'buy') {

    const type = args[2];

    if (!['normal','special','universal'].includes(type)) {
      return message.reply("❌ Invalid pack type");
    }

    (async () => {
      try {

        let price = 100;
        if (type === 'special') price = 200;
        if (type === 'universal') price = 300;

        // ensure user exists
        await runQuery(
          `INSERT OR IGNORE INTO users (userId, coins, normalPacks, specialPacks, universalPacks) 
VALUES (?, 0, 0, 0, 0)`,
          [message.author.id]
        );

        const user = await getQuery(
          `SELECT coins FROM users WHERE userId=?`,
          [message.author.id]
        );

        if (user.coins < price) {
          return message.reply(`❌ Not enough ${COIN}`);
        }

        // 💸 deduct coins
        await runQuery(
          `UPDATE users SET coins = coins - ? WHERE userId = ?`,
          [price, message.author.id]
        );

        // 🎒 ADD PACK TO USER
        await runQuery(
          `UPDATE users SET ${type}Packs = ${type}Packs + 1 WHERE userId = ?`,
          [message.author.id]
        );

        return message.reply(`✅ You bought **1 ${type} pack**! Use \`.open ${type}\``);

      } catch (err) {
        console.error("SHOP ERROR:", err);
        message.reply("❌ Shop crashed");
      }
    })();
  }
}

// 🎴 OPEN PACK
if (content.startsWith('.open')) {

  const args = content.split(' ');
  const type = args[1];

  if (!['normal','special','universal'].includes(type)) {
    return message.reply("❌ Use: .open normal/special/universal");
  }

  (async () => {
    try {

      const user = await getQuery(
        `SELECT ${type}Packs FROM users WHERE userId=?`,
        [message.author.id]
      );

      if (!user || user[`${type}Packs`] <= 0) {
        return message.reply(`❌ You don't have any ${type} packs`);
      }

      // ❌ REMOVE PACK
      await runQuery(
        `UPDATE users SET ${type}Packs = ${type}Packs - 1 WHERE userId = ?`,
        [message.author.id]
      );

      const allCards = await allQuery(`SELECT * FROM game_cards`);
      if (!allCards.length) {
        return message.reply("❌ No cards in game database");
      }

      let results = [];
      let codes = [];
      let threeStarCount = 0;

      for (let i = 0; i < 5; i++) {

        const rarity = rollPackRarity(type, threeStarCount);
        if (rarity === 3) threeStarCount++;

        let pool = allCards.filter(c => c.stars === rarity);
        if (!pool.length) pool = allCards;

        const c = pool[Math.floor(Math.random() * pool.length)];

        const code = await generateUniqueCode({
          name: c.name,
          group: c.groupName,
          era: c.era
        });

        const countRow = await getQuery(
          `SELECT COUNT(*) as total FROM cards WHERE LOWER(cardName)=LOWER(?) AND LOWER(era)=LOWER(?)`,
          [c.name, c.era]
        );

        const copyNumber = (countRow?.total || 0) + 1;

        await runQuery(
          `INSERT INTO cards (userId, cardName, era, code, createdAt, copyNumber, stars, groupName)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            message.author.id,
            c.name,
            c.era,
            code,
            Date.now(),
            copyNumber,
            c.stars,
            c.groupName
          ]
        );

        results.push(`${c.name} (${c.groupName}) ${getStars(c.stars)}`);
        codes.push(`\`${code}\``);
      }

      return message.reply({
        embeds: [{
          color: 0xff69b4,
          title: `${type.toUpperCase()} PACK OPENED`,
          description:
`${results.join('\n')}

🎫 Codes:
${codes.join(', ')}`
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ Failed to open pack");
    }
  })();
}

// 👑 MASTER USER COMMANDS
if (content.startsWith('.mur')) {

  if (!message.member.roles.cache.has(ROLE_MUR)) {
    return message.reply("❌ No permission");
  }

  const args = message.content.split(' ');
  const sub = args[1];

  // 🎁 AWARD SYSTEM
  if (sub === 'award') {
    (async () => {

      const type = args[2]; // coins OR pack

      // 💰 GIVE COINS
      if (type === 'coins') {

        const targetUser = await resolveUser(message, args[3]);
        const amount = parseInt(args[4]);

        if (!targetUser || !amount) {
          return message.reply("❌ Use: .mur award coins @user/id <amount>");
        }

        await runQuery(
          `INSERT OR IGNORE INTO users (userId, coins, normalPacks, specialPacks, universalPacks)
           VALUES (?, 0, 0, 0, 0)`,
          [targetUser.id]
        );

        await runQuery(
          `UPDATE users SET coins = coins + ? WHERE userId = ?`,
          [amount, targetUser.id]
        );

        return message.reply(`👑 Gave ${amount} ${COIN} to ${targetUser.username}`);
      }

      // 🎁 GIVE PACK
      if (type === 'pack') {

        const packType = args[3]?.toLowerCase();
        const targetUser = await resolveUser(message, args[4]);

        if (!['normal','special','universal'].includes(packType)) {
          return message.reply("❌ Use: .mur award pack normal/special/universal @user");
        }

        if (!targetUser) {
          return message.reply("❌ Mention a user or provide ID");
        }

        await runQuery(
          `INSERT OR IGNORE INTO users (userId, coins, normalPacks, specialPacks, universalPacks)
           VALUES (?, 0, 0, 0, 0)`,
          [targetUser.id]
        );

        await runQuery(
          `UPDATE users SET ${packType}Packs = ${packType}Packs + 1 WHERE userId = ?`,
          [targetUser.id]
        );

        return message.reply(
          `👑 Gave **1 ${packType} pack** to ${targetUser.username}`
        );
      }

      return message.reply("❌ Use: .mur award coins OR .mur award pack");

    })();
  }

  if (sub === 'unban') {
  (async () => {
    try {

      // 👤 Get mentioned user
      const targetUser = message.mentions.users.first();

      if (!targetUser) {
        return message.reply("❌ Please mention a user to unban");
      }

      // 🔓 Remove ban in DB
      await runQuery(
        `UPDATE users SET banned = 0 WHERE userId = ?`,
        [targetUser.id]
      );

      return message.reply(`✅ ${targetUser.tag} has been unbanned`);

    } catch (err) {
      console.error(err);
      return message.reply("❌ Unban failed");
    }
  })();
}

  // 🔨 BAN USER
  if (sub === 'ban') {
    (async () => {

      const targetUser = await resolveUser(message, args[2]);

      if (!targetUser) {
        return message.reply("❌ Use: .mur ban @user/id");
      }

      await runQuery(
        `INSERT OR IGNORE INTO users (userId, coins) VALUES (?, 0)`,
        [targetUser.id]
      );

      await runQuery(
        `UPDATE users SET coins = -999999 WHERE userId = ?`,
        [targetUser.id]
      );

      await runQuery(
  `UPDATE users SET banned = 1 WHERE userId = ?`,
  [targetUser.id]
);

      return message.reply(`🔨 ${targetUser.username} has been banned from economy.`);
    })();
  }
}

// 🎁 DAILY SYSTEM
if (content.startsWith('.daily')) {
  (async () => {
    // 🔔 UPDATE LAST CHANNEL
if (reminderUsers.has(message.author.id)) {
  reminderUsers.set(message.author.id, message.channel.id);
}
    try {

      const now = Date.now();

      // ensure user exists
      await runQuery(
        `INSERT OR IGNORE INTO users (userId, coins, dailyStreak, lastDaily) 
         VALUES (?, 0, 0, 0)`,
        [message.author.id]
      );

      const user = await getQuery(
        `SELECT dailyStreak, lastDaily FROM users WHERE userId=?`,
        [message.author.id]
      );

      const last = user.lastDaily || 0;
      const diff = now - last;

      const DAY = 24 * 60 * 60 * 1000;

      // ❌ COOLDOWN
      if (diff < DAY) {
        const remaining = ((DAY - diff) / 1000 / 60 / 60).toFixed(1);
        return message.reply(`⏳ Come back in ${remaining} hours`);
      }

      let streak = user.dailyStreak || 0;

      // ❌ STREAK BREAK
      if (diff > DAY * 2) {
        streak = 0;
      }

      // ✅ INCREMENT
      streak++;

      // ⭐ REWARD LOGIC
      let rewardStars = 1;

      if (streak % 14 === 0) rewardStars = 3;
      else if (streak % 7 === 0) rewardStars = 2;

      // 🎯 GET CARD
      const allCards = await allQuery(
        `SELECT * FROM game_cards WHERE stars=?`,
        [rewardStars]
      );

      if (!allCards.length) {
        return message.reply("❌ No cards available for this reward tier");
      }

      const c = allCards[Math.floor(Math.random() * allCards.length)];

      // 🔑 CODE
      const code = await generateUniqueCode({
        name: c.name,
        group: c.groupName,
        era: c.era
      });

      // 🧬 COPY NUMBER
      const countRow = await getQuery(
        `SELECT COUNT(*) as total FROM cards WHERE LOWER(cardName)=LOWER(?) AND LOWER(era)=LOWER(?)`,
        [c.name, c.era]
      );

      const copyNumber = (countRow?.total || 0) + 1;

      // 💾 SAVE CARD
      await runQuery(
        `INSERT INTO cards (userId, cardName, era, code, createdAt, copyNumber, stars, groupName)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          message.author.id,
          c.name,
          c.era,
          code,
          Date.now(),
          copyNumber,
          c.stars,
          c.groupName
        ]
      );

      // 💾 SAVE STREAK
      await runQuery(
        `UPDATE users SET dailyStreak=?, lastDaily=? WHERE userId=?`,
        [streak, now, message.author.id]
      );

      // 🔔 DAILY REMINDER (CHANNEL VERSION ✅ FIXED)
      if (reminderUsers.has(message.author.id)) {
        const chId = reminderUsers.get(message.author.id);

        setTimeout(async () => {
          try {
            const channel = await client.channels.fetch(chId);
            channel.send(`🔔 <@${message.author.id}> your **daily reward** is ready!`);
          } catch {}
        }, 24 * 60 * 60 * 1000);
      }

      // 🎴 RESPONSE
      return message.reply({
        embeds: [{
          color: 0x00ffcc,
          title: "🎁 Daily Reward",
          description:
`🔥 Streak: **${streak} days**
⭐ Reward: ${getStars(rewardStars)}

🎫 Code: **${code}**`,
          image: { url: c.image }
        }]
      });

    } catch (err) {
      console.error(err);
      message.reply("❌ Daily failed");
    }
  })();
}

// 🔔 REMINDER TOGGLE (CHANNEL BASED)
if (content.startsWith('.reminder')) {

  const args = content.split(' ');
  const sub = args[1];

  if (!sub) {
    return message.reply("❌ Use: .reminder on / off");
  }

  if (sub === 'on') {
    reminderUsers.set(message.author.id, {
      channelId: message.channel.id,
      enabled: true
    });
    return message.reply("🔔 Reminders ENABLED!");
  }

  if (sub === 'off') {
    reminderUsers.set(message.author.id, {
      channelId: message.channel.id,
      enabled: false
    });
    return message.reply("🔕 Reminders DISABLED (silent mode)");
  }

  return message.reply("❌ Use: .reminder on / off");
}

// 🎒 INVENTORY (FINAL FIXED VERSION)
if (content.startsWith('.inv')) {
  (async () => {

    try {

      const raw = message.content.slice(4).trim();

      // 👤 USER RESOLVE
      const argsArray = raw.split(' ');
      const resolved = await resolveUser(message, argsArray[0]);
      const targetUser = resolved || message.author;

      // 📦 FETCH USER CARDS
      const rows = await allQuery(
        `SELECT * FROM cards WHERE userId=? ORDER BY id ASC`,
        [targetUser.id]
      );

      if (!rows.length) return message.reply("📭 Empty");

      let list = rows.map(r => ({
        id: r.id,
        name: r.cardName,
        era: r.era,
        group: r.groupName || "Unknown",
        stars: r.stars || 1,
        code: r.code
      }));

      // 🔍 FILTER PARSE (name=xxx group=xxx rarity=2)
      const matches = raw.match(/(\w+)=("[^"]+"|\S+)/g) || [];

      let filter = {};
      let sortBy = null;

      matches.forEach(p => {
        let [k, v] = p.split('=');
        v = v.replace(/"/g, '').toLowerCase();
        filter[k.toLowerCase()] = v;
      });

      const extra = raw.split(' ').filter(x => !x.includes('='));
      if (extra.length) sortBy = extra[extra.length - 1].toLowerCase();

      // 🔍 FILTER LOGIC
      list = list.filter(c => {
        return Object.entries(filter).every(([k, v]) => {

          if (k === 'rarity') {
            return String(c.stars) === v;
          }

          if (!['name', 'group', 'era'].includes(k)) return true;

          return (c[k] || "").toLowerCase().includes(v);
        });
      });

      // 🔄 SORTING
      if (sortBy === 'name') list.sort((a,b)=>a.name.localeCompare(b.name));
      if (sortBy === 'group') list.sort((a,b)=>a.group.localeCompare(b.group));
      if (sortBy === 'era') list.sort((a,b)=>a.era.localeCompare(b.era));
      if (sortBy === 'stars') list.sort((a,b)=>b.stars - a.stars);
      if (sortBy === 'starsasc') list.sort((a,b)=>a.stars - b.stars);

      // 📄 PAGINATION
      const PAGE_SIZE = 15;
      const page = 1;
      const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));

      const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      // 📋 SAVE CODES FOR BUTTON (🔥 FIXED ISSUE)
      const codes = slice.map(c => c.code).filter(Boolean);

      const embed = {
        color: 0x7289da,
        title: `🎒 ${targetUser.username}'s Cards (Page ${page}/${totalPages})`,
        description: slice.map(c =>
          `${c.name} | ${c.group} | ${c.era} | ${getStars(c.stars)} - \`${c.code}\``
        ).join('\n') || "📭 No cards found"
      };

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`inv_prev_${page}`)
          .setLabel('⬅ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 1),

        new ButtonBuilder()
          .setCustomId(`inv_next_${page}`)
          .setLabel('Next ➡')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === totalPages),

        new ButtonBuilder()
          .setCustomId(`inv_copy_${page}`)
          .setLabel('📋 Copy Codes')
          .setStyle(ButtonStyle.Success)
      );

      const replyMsg = await message.reply({
        embeds: [embed],
        components: [row]
      });

      // 💾 SAVE STATE (IMPORTANT)
      invStateMap.set(replyMsg.id, {
        list,
        page,
        userId: targetUser.id,
        codes // 🔥 FIX: now stored properly
      });

      setTimeout(() => invStateMap.delete(replyMsg.id), 5 * 60 * 1000);

    } catch (err) {
      console.error(err);
      return message.reply("❌ Inventory error occurred");
    }

  })();
} 

// 🔍 SEARCH SYSTEM (WITH PAGINATION + OWNER VIEW)
if (content.startsWith('.search')) {
  (async () => {
    try {

      const raw = message.content.slice(7).trim();

      const rows = await allQuery(`SELECT * FROM cards ORDER BY id ASC`);
      if (!rows.length) return message.reply("📭 No cards exist");

      let list = rows.map(r => ({
        name: r.cardName,
        era: r.era,
        group: r.groupName || "Unknown",
        stars: r.stars || 1,
        code: r.code,
        owner: r.userId
      }));

      // 🔍 FILTER
      const matches = raw.match(/(\w+)=("[^"]+"|\S+)/g) || [];
      let filter = {};

      matches.forEach(p => {
        let [k, v] = p.split('=');
        v = v.replace(/"/g, '').toLowerCase();
        filter[k.toLowerCase()] = v;
      });

      list = list.filter(c => {
        return Object.entries(filter).every(([k, v]) => {

          if (k === 'rarity') return String(c.stars) === v;
          if (!['name', 'group', 'era'].includes(k)) return true;

          return (c[k] || "").toLowerCase().includes(v);
        });
      });

      if (!list.length) {
        return message.reply("❌ No cards found");
      }

      const PAGE_SIZE = 15;
      const page = 1;
      const totalPages = Math.ceil(list.length / PAGE_SIZE);

      const slice = list.slice(0, PAGE_SIZE);

      const embed = {
        color: 0x00ccff,
        title: `🔍 Search Results (Page ${page}/${totalPages})`,
        description: slice.map(c =>
          `${c.name} | ${c.group} | ${c.era} | ${getStars(c.stars)}\n\`${c.code}\``
        ).join('\n\n')
      };

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`search_prev_${page}`)
          .setLabel('⬅ Prev')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),

        new ButtonBuilder()
          .setCustomId(`search_next_${page}`)
          .setLabel('Next ➡')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(page === totalPages),

        new ButtonBuilder()
          .setCustomId(`search_users_${page}`)
          .setLabel('👤 See Owners')
          .setStyle(ButtonStyle.Success)
      );

      const replyMsg = await message.reply({
        embeds: [embed],
        components: [row]
      });

      // 💾 SAVE STATE
      searchStateMap.set(replyMsg.id, {
        list,
        page,
        userId: message.author.id
      });

      setTimeout(() => searchStateMap.delete(replyMsg.id), 5 * 60 * 1000);

    } catch (err) {
      console.error(err);
      message.reply("❌ Search failed");
    }
  })();
}

//sell
if (content.startsWith('.sell')) {
  (async () => {
    try {

      const args = message.content.split(' ');
      const code = args[1]?.toLowerCase();
      const price = parseInt(args[2]);

      if (!code || !price || price <= 0) {
        return message.reply(`❌ Use: ${PREFIX}sell <code> <price>`);
      }

      const card = await getQuery(
        `SELECT * FROM cards WHERE LOWER(code)=? AND userId=?`,
        [code, message.author.id]
      );

      if (!card) return message.reply("❌ You don't own this card!");
      if (card.listed == 1) return message.reply("❌ Already listed!");

      await runQuery(
        `UPDATE cards SET listed=1, price=? WHERE id=?`,
        [price, card.id]
      );

      message.reply(`🛒 Listed **${card.cardName} (${card.era})** for ${price} ${COIN}`);

    } catch (err) {
      console.error(err);
      message.reply("❌ Sell failed!");
    }
  })();
}

if (content.startsWith('.unsell')) {
  (async () => {
    try {

      const code = message.content.split(' ')[1]?.toLowerCase();

      if (!code) return message.reply(`❌ Use: ${PREFIX}unsell <code>`);

      const card = await getQuery(
        `SELECT * FROM cards WHERE LOWER(code)=? AND userId=?`,
        [code, message.author.id]
      );

      if (!card) return message.reply("❌ You don't own this card!");
      if (card.listed != 1) return message.reply("❌ Card is not listed!");

      await runQuery(
        `UPDATE cards SET listed=0, price=NULL WHERE id=?`,
        [card.id]
      );

      message.reply("✅ Card removed from marketplace");

    } catch (err) {
      console.error(err);
      message.reply("❌ Unsell failed!");
    }
  })();
}

// 🛒 MARKETPLACE (WITH PAGINATION)
if (content.startsWith('.mp')) {
  (async () => {

    const raw = message.content.slice(3).trim();
    const PAGE_SIZE = 15;

    let rows = await allQuery(`SELECT * FROM cards WHERE listed=1`);

    if (!rows.length) {
      return message.reply("🛒 Marketplace is empty!");
    }

    let list = rows.map(c => ({
      name: c.cardName,
      group: c.groupName || "Unknown",
      era: c.era,
      stars: c.stars,
      code: c.code,
      price: c.price,
      owner: c.userId
    }));

    const matches = raw.match(/(\w+)=("[^"]+"|\S+)/g) || [];
    let filter = {};

    matches.forEach(p => {
      let [k, v] = p.split('=');
      v = v.replace(/"/g, '').toLowerCase();
      filter[k.toLowerCase()] = v;
    });

    list = list.filter(c => {
      return Object.entries(filter).every(([k, v]) => {
        if (k === 'rarity') return String(c.stars) === v;
        if (!['name','group','era'].includes(k)) return true;
        return (c[k] || "").toLowerCase().includes(v);
      });
    });

    if (raw.includes('sort=price')) list.sort((a,b)=>a.price - b.price);
    if (raw.includes('sort=stars')) list.sort((a,b)=>b.stars - a.stars);

    const page = 1;
    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));

    const slice = list.slice(0, PAGE_SIZE);

    const left = slice.slice(0, 8);
const right = slice.slice(8, 15);

const leftText = left.map((c, i) =>
  `**${i+1}.** ${c.name} | ${c.group} | ${c.era}
${getStars(c.stars)} 💰${c.price}
👤 <@${c.owner}>
\`${c.code}\``
).join('\n\n') || "—";

const rightText = right.map((c, i) =>
  `**${i+9}.** ${c.name} | ${c.group} | ${c.era}
${getStars(c.stars)} 💰${c.price}
👤 <@${c.owner}>
\`${c.code}\``
).join('\n\n') || "—";

const embed = {
  color: 0x0099ff,
  title: `🛒 Marketplace (Page ${page}/${totalPages})`,
  fields: [
    { name: "📦 Listings", value: leftText, inline: true },
    { name: "📦 More", value: rightText, inline: true }
  ]
};
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mp_prev_${page}`)
        .setLabel('⬅ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),

      new ButtonBuilder()
        .setCustomId(`mp_next_${page}`)
        .setLabel('Next ➡')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === totalPages),

      new ButtonBuilder()
        .setCustomId(`mp_copy_${page}`)
        .setLabel('📋 Copy Codes + Owners')
        .setStyle(ButtonStyle.Success)
    );

    const replyMsg = await message.reply({
      embeds: [embed],
      components: [row]
    });

    searchStateMap.set(replyMsg.id, {
      list,
      page
    });

  })();
}

//buying from mp
if (content.startsWith('.buy')) {
  (async () => {
    try {

      const code = message.content.split(' ')[1]?.toLowerCase();
      if (!code) return message.reply(`❌ Use: ${PREFIX}buy <code>`);

      const card = await getQuery(
        `SELECT * FROM cards WHERE LOWER(code)=? AND listed=1`,
        [code]
      );

      if (!card) return message.reply("❌ Not in marketplace!");
      if (card.userId === message.author.id)
        return message.reply("❌ You already own this!");

      await runQuery(`INSERT OR IGNORE INTO users (userId, coins) VALUES (?,0)`, [message.author.id]);
      await runQuery(`INSERT OR IGNORE INTO users (userId, coins) VALUES (?,0)`, [card.userId]);

      const buyer = await getQuery(
        `SELECT coins FROM users WHERE userId=?`,
        [message.author.id]
      );

      if (buyer.coins < card.price)
        return message.reply("❌ Not enough coins!");

      // transfer
      await runQuery(`UPDATE users SET coins=coins-? WHERE userId=?`, [card.price, message.author.id]);
      await runQuery(`UPDATE users SET coins=coins+? WHERE userId=?`, [card.price, card.userId]);

      // transfer card
      await runQuery(
        `UPDATE cards SET userId=?, listed=0, price=NULL WHERE id=?`,
        [message.author.id, card.id]
      );

      message.reply(`🎉 Bought **${card.cardName} (${card.era})**`);

    } catch (err) {
      console.error(err);
      message.reply("❌ Purchase failed!");
    }
  })();
}

// ❓ HELP COMMAND (SHORT & CLEAN)
if (content.startsWith('.help')) {
  (async () => {

    const embed = {
      color: 0x5865f2,
      title: "📘 JuriBot Help",
      description: "Welcome to Juri Bot 💎",

      fields: [

        {
          name: "Basic Commands",
          value:
`.drop → Get a random card  
.work → Earn JuriBucks  
.bal → Check your JuriBucks  
.inv → View your cards`
        },

        {
          name: "Card System",
          value:
`.evolve <codes> → Upgrade cards  
(3 same cards → higher level)

.search → View all cards in game`
        },

        {
          name: "Trading",
          value:
`.gift @user <code> → Give card  
.give @user <amount> → Give JuriBucks`
        },

        {
          name: "Marketplace",
          value:
`.mp → View market  
.sell <code> <price> → Sell card  
.unsell <code> → Remove from market  
.buy <code> → Buy card`
        },

        {
          name: "Profile",
          value:
`.p → View profile  
.des → Set description`
        },

        {
          name: "Extras",
          value:
`.t → Check cooldowns  
.daily → Get daily card`
        }

      ],

      footer: {
        text: "Use commands wisely 💎"
      }
    };

    message.reply({ embeds: [embed] });

  })();
}

});

// Close DB
process.on('SIGINT', () => {
  db.close();
  process.exit();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  // 📋 COPY ALL CODES
  if (interaction.customId.startsWith('inv_copy_')) {

  const data = invStateMap.get(interaction.message.id);

  if (!data || !data.codes?.length) {
    return interaction.reply({
      content: "📭 No codes available.",
      ephemeral: true
    });
  }

  return interaction.reply({
    content: `📋 Card Codes:\n\`\`\`${data.codes.join(', ')}\`\`\``,
    ephemeral: true
  });
}

  // 🚀 GAME READY (SEPARATE BLOCK)
if (interaction.customId === 'game_ready') {

  if (!interaction.member.roles.cache.has(ROLE_B)) {
    return interaction.reply({
      content: "❌ No permission",
      ephemeral: true
    });
  }

  try {
    const rows = await allQuery(`SELECT * FROM approved_cards`);

    if (!rows.length) {
      return interaction.reply({
        content: "📭 No approved cards.",
        ephemeral: true
      });
    }

    let added = 0;

    for (const c of rows) {

      // ✅ SAVE INTO PERMANENT GAME TABLE
      await runQuery(
        `INSERT INTO game_cards (name, groupName, era, stars, image, creatorId)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [c.name, c.groupName, c.era, c.stars, c.image, c.creatorId]
      );

      // ✅ DELETE FROM APPROVAL
      await runQuery(`DELETE FROM approved_cards WHERE id=?`, [c.id]);

      added++;
    }

    return interaction.reply({
      content: `${added} Cards added to the game permanently!`,
    });

  } catch (err) {
    console.error(err);
    return interaction.reply({
      content: "❌ Failed to move cards",
    });
  }
}

// 🧬 EVOLVE BUTTON HANDLER
if (interaction.customId.startsWith('evolve_')) {

  const messageId = interaction.message?.id;

if (!messageId) {
  return interaction.reply({ content: "❌ Invalid interaction", ephemeral: true });
}

const data = evolveMap.get(messageId);
  if (!data) {
    return interaction.reply({ content: "❌ Expired", ephemeral: true });
  }

  if (interaction.user.id !== data.userId) {
    return interaction.reply({ content: "❌ Not your evolve!", ephemeral: true });
  }

  // ❌ CANCEL
  if (interaction.customId.startsWith('evolve_cancel')) {
    evolveMap.delete(interaction.message.id);
    return interaction.update({
      content: "❌ Evolution cancelled",
      embeds: [],
      components: []
    });
  }

// ✅ CONFIRM
if (interaction.customId.startsWith('evolve_confirm')) {

  try {

    const data = evolveMap.get(interaction.message.id);

    if (!data) {
      return interaction.reply({ content: "❌ Evolution expired", ephemeral: true });
    }

    if (interaction.user.id !== data.userId) {
      return interaction.reply({ content: "❌ Not your evolution", ephemeral: true });
    }

    const { cards, eraPool, baseName, group } = data;

    // 🧠 BASE STARS
    const baseStars = cards[0].stars || 1;

    // 🎯 HOW MANY OUTPUT CARDS
    const outputCount = Math.floor(cards.length / 3);

    // ⭐ FINAL STAR LEVEL
    const nextStars = Math.min(baseStars + 1, 3);

    // 🎯 GET POSSIBLE CARDS
    const possible = await allQuery(
      `SELECT * FROM game_cards 
       WHERE stars=? 
       AND LOWER(groupName)=LOWER(?) 
       AND LOWER(name)=LOWER(?)`,
      [nextStars, group, baseName]
    );

    if (!possible.length) {
      return interaction.reply({ content: "❌ No higher tier cards", ephemeral: true });
    }

    // 🗑 MOVE CARDS TO BOTS INV
    const BOT_ID = client.user.id;

for (const card of cards) {

  const result = await runQuery(
    `UPDATE cards 
     SET userId=? 
     WHERE code=? AND userId=?`,
    [BOT_ID, card.code, interaction.user.id]
  );

  // 🚨 SAFETY CHECK
  if (!result || result.changes === 0) {
    return interaction.reply({
      content: `❌ Evolve failed (card ${card.code} not found or already moved)`,
      ephemeral: true
    });
  }
}

    let createdCards = [];

    // 🔁 CREATE MULTIPLE CARDS
    for (let i = 0; i < outputCount; i++) {

      const newCard = possible[Math.floor(Math.random() * possible.length)];

      const randomEra = eraPool[Math.floor(Math.random() * eraPool.length)];

      const code = await generateUniqueCode({
        name: newCard.name,
        group: newCard.groupName,
        era: randomEra
      });

      const countRow = await getQuery(
        `SELECT COUNT(*) as total FROM cards 
         WHERE LOWER(cardName)=LOWER(?) AND LOWER(era)=LOWER(?)`,
        [newCard.name, randomEra]
      );

      const copyNumber = (countRow?.total || 0) + 1;

      await runQuery(
        `INSERT INTO cards (userId, cardName, era, code, stars, groupName, createdAt, copyNumber)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          interaction.user.id,
          newCard.name,
          randomEra,
          code,
          nextStars,
          newCard.groupName,
          Date.now(),
          copyNumber
        ]
      );

      createdCards.push(`🎫 \`${code}\``);
    }

    evolveMap.delete(interaction.message.id);

    return interaction.update({
      embeds: [{
        color: 0x00ff99,
        title: "🧬 Evolution Success!",
        description: `✨ Created **${outputCount} card(s)**\n🏷️ ${group} | ${nextStars}★\n\n${createdCards.join('\n')}`
      }],
      components: []
    });

  } catch (err) {
    console.error(err);
    return interaction.reply({ content: "❌ Evolution failed", ephemeral: true });
  }
}
}

  // 📖 INVENTORY PAGINATION
if (interaction.customId.startsWith('inv_')) {
  (async () => {

    const state = invStateMap.get(interaction.message.id);

    if (!state) {
      return interaction.reply({
        content: "❌ Inventory expired. Run .inv again.",
        ephemeral: true
      });
    }

    const { list } = state;

    const PAGE_SIZE = 15;

    const parts = interaction.customId.split('_');
const action = parts[1];
let page = parseInt(parts[2]); // ✅ FIXED

    const totalPages = Math.ceil(list.length / PAGE_SIZE);

    if (action === 'next') page++;
    if (action === 'prev') page--;

    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const start = (page - 1) * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);
// ✅ UPDATE CODES FOR CURRENT PAGE
const codes = slice.map(c => c.code).filter(Boolean);

// 🔄 SAVE UPDATED STATE
invStateMap.set(interaction.message.id, {
  ...state,
  page,
  codes
});
    const embed = {
      color: 0x7289da,
      title: `🎒 Inventory (Page ${page}/${totalPages})`,
      description: slice.map((c, i) =>
        `${start + i + 1}. ${c.name} (${c.era}) ${getStars(c.stars)} - \`${c.code}\``
      ).join('\n')
    };

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`inv_prev_${page}`)
        .setLabel('⬅ Prev')
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId(`inv_next_${page}`)
        .setLabel('Next ➡')
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId(`inv_copy_${page}`)
        .setLabel('📋 Copy Codes')
        .setStyle(ButtonStyle.Success)
    );

    await interaction.update({
      embeds: [embed],
      components: [row]
    });

  })();
}

// 🔍 SEARCH PAGINATION + USERS BUTTON
if (interaction.customId.startsWith('search_')) {
  (async () => {

    const state = searchStateMap.get(interaction.message.id);

    if (!state) {
      return interaction.reply({
        content: "❌ Search expired",
        ephemeral: true
      });
    }

    const { list } = state;
    const PAGE_SIZE = 15;

    let [_, action, pageStr] = interaction.customId.split('_');
    let page = parseInt(pageStr);

    const totalPages = Math.ceil(list.length / PAGE_SIZE);

    if (action === 'next') page++;
    if (action === 'prev') page--;

    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const start = (page - 1) * PAGE_SIZE;
    const slice = list.slice(start, start + PAGE_SIZE);

    // 👤 SEE USERS BUTTON
    if (action === 'users') {
      const owners = slice.map(c => c.owner);

      return interaction.reply({
        content: `👤 Owners:\n\`\`\`${owners.join('\n')}\`\`\``,
        ephemeral: true
      });
    }

const embed = {
  color: 0x00ccff,
  title: `🔍 Search Results (Page ${page}/${totalPages})`,
  description: slice.map((c, i) =>
    `**${(page - 1) * PAGE_SIZE + i + 1}.** ${c.name} | ${c.group} | ${c.era} | ${getStars(c.stars)}
\`${c.code}\``
  ).join('\n\n')
};

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`search_prev_${page}`)
        .setLabel('⬅ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),

      new ButtonBuilder()
        .setCustomId(`search_next_${page}`)
        .setLabel('Next ➡')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === totalPages),

      new ButtonBuilder()
        .setCustomId(`search_users_${page}`)
        .setLabel('👤 See Owners')
        .setStyle(ButtonStyle.Success)
    );

    await interaction.update({
      embeds: [embed],
      components: [row]
    });

  })();
}


//marketplace
if (interaction.customId.startsWith('mp_copy_')) {

  const state = searchStateMap.get(interaction.message.id);

  if (!state) {
    return interaction.reply({
      content: "❌ Expired",
      ephemeral: true
    });
  }

  const PAGE_SIZE = 15;
  const { list, page } = state;

  const start = (page - 1) * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);

  const text = slice.map(c =>
    `${c.code} (Owner: ${c.owner})`
  ).join(', ');

  return interaction.reply({
    content: `📋 Codes + Owners:\n\`\`\`${text}\`\`\``,
    ephemeral: true
  });
}

// 🛒 MARKETPLACE PAGINATION
if (interaction.customId.startsWith('mp_')) {
  (async () => {

    const state = searchStateMap.get(interaction.message.id);

    if (!state) {
      return interaction.reply({
        content: "❌ Marketplace expired. Run .mp again.",
        ephemeral: true
      });
    }

    let { list, page } = state;
    const PAGE_SIZE = 15;

    if (interaction.customId.startsWith('mp_next')) page++;
    if (interaction.customId.startsWith('mp_prev')) page--;

    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));

    if (page < 1) page = 1;
    if (page > totalPages) page = totalPages;

    const slice = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

    const left = slice.slice(0, 8);
const right = slice.slice(8, 15);

const leftText = left.map((c, i) =>
  `**${i+1}.** ${c.name}
${getStars(c.stars)} 💰${c.price}
\`${c.code}\``
).join('\n\n') || "—";

const rightText = right.map((c, i) =>
  `**${i+9}.** ${c.name}
${getStars(c.stars)} 💰${c.price}
\`${c.code}\``
).join('\n\n') || "—";

const embed = {
  color: 0x0099ff,
  title: `🛒 Marketplace (Page ${page}/${totalPages})`,
  fields: [
    { name: "📦 Listings", value: leftText, inline: true },
    { name: "📦 More", value: rightText, inline: true }
  ]
};

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mp_prev_${page}`)
        .setLabel('⬅ Prev')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 1),

      new ButtonBuilder()
        .setCustomId(`mp_next_${page}`)
        .setLabel('Next ➡')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(page === totalPages),

      new ButtonBuilder()
        .setCustomId(`mp_copy_${page}`)
        .setLabel('📋 Copy Codes + Owners')
        .setStyle(ButtonStyle.Success)
    );

    // 💾 UPDATE STATE
    state.page = page;

    await interaction.update({
      embeds: [embed],
      components: [row]
    });

  })();
}

});

// Login
client.login(process.env.TOKEN);
