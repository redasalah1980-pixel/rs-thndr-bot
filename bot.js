const https = require('https');
const http = require('http');

// ===== CONFIG =====
const BOT_TOKEN = '8984910077:AAF28kk3PvJn_oaeNu_0cPmTGrl22gDpDDo';
const CHAT_ID = '344402775';
const FIREBASE_URL = 'https://rs-thndr-assistant-default-rtdb.europe-west1.firebasedatabase.app';
const CHECK_INTERVAL = 60 * 60 * 1000; // كل ساعة

// ===== Send Telegram Message =====
function sendMessage(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'HTML'
    });
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ===== Get Stock Price from Yahoo Finance =====
function getStockPrice(symbol) {
  return new Promise((resolve) => {
    const egSymbol = symbol + '.CA';
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${egSymbol}?interval=1d&range=1d`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const price = json?.chart?.result?.[0]?.meta?.regularMarketPrice;
          resolve(price || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ===== Get Firebase Data =====
function getFirebaseData(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${FIREBASE_URL}/${path}.json`);
    https.get(url.href, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', reject);
  });
}

// ===== Update Firebase Price =====
function updateFirebasePrice(path, price) {
  return new Promise((resolve) => {
    const body = JSON.stringify(price);
    const url = new URL(`${FIREBASE_URL}/${path}.json`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

// ===== Check Portfolio Alerts =====
async function checkPortfolioAlerts() {
  console.log('🔍 Checking portfolio alerts...');
  const portfolio = await getFirebaseData('portfolio');
  if (!portfolio) return;

  const alerts = [];

  for (const [key, stock] of Object.entries(portfolio)) {
    if (!stock.symbol) continue;

    const livePrice = await getStockPrice(stock.symbol);
    if (!livePrice) {
      console.log(`⚠️ Could not get price for ${stock.symbol}`);
      continue;
    }

    console.log(`📊 ${stock.symbol}: Live=${livePrice}, AlertUp=${stock.alertUp}, AlertDown=${stock.alertDown}`);

    // Update current price in Firebase
    await updateFirebasePrice(`portfolio/${key}`, { currentPrice: livePrice });

    // Check alert up
    if (stock.alertUp && livePrice >= stock.alertUp) {
      alerts.push({
        type: 'up',
        symbol: stock.symbol,
        name: stock.name || '',
        price: livePrice,
        target: stock.alertUp
      });
    }

    // Check alert down
    if (stock.alertDown && livePrice <= stock.alertDown) {
      alerts.push({
        type: 'down',
        symbol: stock.symbol,
        name: stock.name || '',
        price: livePrice,
        target: stock.alertDown
      });
    }
  }

  // Send alerts
  for (const alert of alerts) {
    const emoji = alert.type === 'up' ? '🟢' : '🔴';
    const msg = `${emoji} <b>تنبيه سهم!</b>\n\n` +
      `📌 <b>${alert.symbol}</b> — ${alert.name}\n` +
      `💰 السعر الحالي: <b>${alert.price.toFixed(2)} ج.م</b>\n` +
      `🎯 سعر التنبيه: ${alert.target.toFixed(2)} ج.م\n\n` +
      (alert.type === 'up'
        ? '✅ السهم وصل هدف الصعود — فكر في جني الأرباح!'
        : '⚠️ السهم وصل سعر التنبيه — راجع قرارك!') +
      '\n\n📱 <i>مساعد ثاندر RS</i>';
    await sendMessage(msg);
    console.log(`✅ Alert sent for ${alert.symbol}`);
  }
}

// ===== Check Watchlist =====
async function checkWatchlist() {
  console.log('👁️ Checking watchlist...');
  const watchlist = await getFirebaseData('watchlist');
  if (!watchlist) return;

  for (const [key, item] of Object.entries(watchlist)) {
    if (!item.symbol || !item.target) continue;

    const livePrice = await getStockPrice(item.symbol);
    if (!livePrice) continue;

    // Update price
    await updateFirebasePrice(`watchlist/${key}`, { current: livePrice });

    // Check if reached target
    if (livePrice <= item.target) {
      const msg = `⭐ <b>تنبيه المراقبة!</b>\n\n` +
        `📌 <b>${item.symbol}</b> — ${item.name || ''}\n` +
        `💰 السعر الحالي: <b>${livePrice.toFixed(2)} ج.م</b>\n` +
        `🎯 سعر الشراء المستهدف: ${item.target.toFixed(2)} ج.م\n\n` +
        `✅ <b>وصل السعر المستهدف!</b> — الفرصة جات! 🚀\n\n` +
        `📱 <i>مساعد ثاندر RS</i>`;
      await sendMessage(msg);
      console.log(`⭐ Watchlist alert sent for ${item.symbol}`);
    }
  }
}

// ===== Morning Summary =====
async function sendMorningSummary() {
  const now = new Date();
  const cairoHour = (now.getUTCHours() + 3) % 24;
  if (cairoHour !== 9) return; // بس الساعة 9 الصبح

  console.log('🌅 Sending morning summary...');
  const portfolio = await getFirebaseData('portfolio');
  if (!portfolio) return;

  const stocks = Object.values(portfolio);
  let totalCost = 0, totalValue = 0;

  for (const s of stocks) {
    totalCost += (s.buyPrice || 0) * (s.shares || 0);
    totalValue += (s.currentPrice || s.buyPrice || 0) * (s.shares || 0);
  }

  const pnl = totalValue - totalCost;
  const pct = totalCost > 0 ? (pnl / totalCost * 100) : 0;

  const msg = `🌅 <b>صباح الخير يا Reda!</b>\n\n` +
    `📊 <b>ملخص محفظتك:</b>\n` +
    `💰 إجمالي الاستثمار: ${totalCost.toFixed(0)} ج.م\n` +
    `📈 القيمة الحالية: ${totalValue.toFixed(0)} ج.م\n` +
    `${pnl >= 0 ? '✅' : '❌'} الربح/الخسارة: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ج.م (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)\n` +
    `📌 عدد الأسهم: ${stocks.length}\n\n` +
    `🕙 البورصة بتفتح الساعة 10 الصبح\n` +
    `📱 <i>مساعد ثاندر RS</i>`;

  await sendMessage(msg);
}

// ===== Main Check Loop =====
async function runChecks() {
  try {
    await checkPortfolioAlerts();
    await checkWatchlist();
    await sendMorningSummary();
  } catch (err) {
    console.error('Error in checks:', err.message);
  }
}

// ===== Handle Telegram Commands =====
async function handleUpdates() {
  let offset = 0;
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
      const data = await new Promise((resolve) => {
        https.get(url, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(JSON.parse(d)));
        }).on('error', () => resolve({ ok: false, result: [] }));
      });

      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const text = update.message?.text;
          const chatId = update.message?.chat?.id;

          if (chatId != CHAT_ID) continue;

          if (text === '/start' || text === '/help') {
            await sendMessage(
              `👋 <b>أهلاً يا Reda!</b>\n\n` +
              `🤖 أنا مساعد ثاندر RS Bot\n\n` +
              `<b>الأوامر المتاحة:</b>\n` +
              `/check — فحص التنبيهات دلوقتي\n` +
              `/summary — ملخص المحفظة\n` +
              `/status — حالة البوت\n\n` +
              `📱 <i>مساعد ثاندر RS</i>`
            );
          } else if (text === '/check') {
            await sendMessage('🔍 جاري فحص التنبيهات...');
            await runChecks();
            await sendMessage('✅ تم الفحص!');
          } else if (text === '/summary') {
            await sendMorningSummary();
          } else if (text === '/status') {
            await sendMessage(
              `✅ <b>البوت شغال!</b>\n\n` +
              `⏰ الفحص كل ساعة\n` +
              `🌅 ملخص صباحي الساعة 9 ص\n` +
              `📱 <i>مساعد ثاندر RS</i>`
            );
          }
        }
      }
    } catch (err) {
      console.error('Update error:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ===== Keepalive Server =====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('RS Thndr Bot is running! 🚀');
}).listen(process.env.PORT || 3000);

// ===== Start =====
console.log('🚀 RS Thndr Bot Starting...');
sendMessage('🚀 <b>مساعد ثاندر Bot شغال!</b>\n\nهيراقب محفظتك وهيبعتلك تنبيهات تلقائية 📊\n\nاكتب /help لقائمة الأوامر').then(() => {
  console.log('✅ Startup message sent');
});

// Run checks immediately then every hour
runChecks();
setInterval(runChecks, CHECK_INTERVAL);

// Handle Telegram commands
handleUpdates();

console.log('✅ Bot is running!');
