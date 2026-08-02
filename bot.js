const https = require('https');
const http = require('http');

// ===== CONFIG =====
const BOT_TOKEN = '8984910077:AAF28kk3PvJn_oaeNu_0cPmTGrl22gDpDDo';
const CHAT_ID = '344402775';
const FIREBASE_URL = 'https://rs-thndr-assistant-default-rtdb.europe-west1.firebasedatabase.app';
const CHECK_INTERVAL = 60 * 60 * 1000;

// ===== Send Telegram Message =====
function sendMessage(text, chatId) {
  chatId = chatId || CHAT_ID;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: chatId,
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
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          console.log('Message sent:', result.ok);
          resolve(result);
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.error('Send error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ===== Get Updates with Webhook =====
function getUpdates(offset) {
  return new Promise((resolve) => {
    const path = `/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=10&allowed_updates=["message"]`;
    const options = {
      hostname: 'api.telegram.org',
      path: path,
      method: 'GET',
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ ok: false, result: [] }); }
      });
    });
    req.on('error', () => resolve({ ok: false, result: [] }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, result: [] }); });
    req.end();
  });
}

// ===== Get Firebase Data =====
function getFirebaseData(path) {
  return new Promise((resolve) => {
    const url = `${FIREBASE_URL}/${path}.json`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ===== Update Firebase =====
function updateFirebase(path, value) {
  return new Promise((resolve) => {
    const body = JSON.stringify(value);
    const urlObj = new URL(`${FIREBASE_URL}/${path}.json`);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
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

// ===== Get Stock Price =====
function getStockPrice(symbol) {
  return new Promise((resolve) => {
    const egSymbol = symbol + '.CA';
    const options = {
      hostname: 'query1.finance.yahoo.com',
      path: `/v8/finance/chart/${egSymbol}?interval=1d&range=1d`,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
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
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ===== Portfolio Summary =====
async function getPortfolioSummary() {
  const portfolio = await getFirebaseData('portfolio');
  if (!portfolio) return 'المحفظة فاضية';
  const stocks = Object.values(portfolio);
  let totalCost = 0, totalValue = 0;
  stocks.forEach(s => {
    totalCost += (s.buyPrice || 0) * (s.shares || 0);
    totalValue += (s.currentPrice || s.buyPrice || 0) * (s.shares || 0);
  });
  const pnl = totalValue - totalCost;
  const pct = totalCost > 0 ? (pnl / totalCost * 100) : 0;
  return `📊 <b>ملخص المحفظة</b>\n\n` +
    `💰 الاستثمار: ${totalCost.toFixed(0)} ج.م\n` +
    `📈 القيمة: ${totalValue.toFixed(0)} ج.م\n` +
    `${pnl >= 0 ? '✅' : '❌'} ربح/خسارة: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ج.م (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)\n` +
    `📌 أسهم: ${stocks.length}`;
}

// ===== Check Alerts =====
async function checkAlerts() {
  console.log('🔍 Checking alerts...');
  const portfolio = await getFirebaseData('portfolio');
  const watchlist = await getFirebaseData('watchlist');
  let alertsSent = 0;

  if (portfolio) {
    for (const [key, stock] of Object.entries(portfolio)) {
      if (!stock.symbol) continue;
      const price = await getStockPrice(stock.symbol);
      if (!price) continue;
      await updateFirebase(`portfolio/${key}`, { currentPrice: price });
      if (stock.alertUp && price >= stock.alertUp) {
        await sendMessage(`🟢 <b>تنبيه صعود!</b>\n\n📌 <b>${stock.symbol}</b>\n💰 السعر: ${price.toFixed(2)} ج.م\n🎯 هدفك: ${stock.alertUp} ج.م\n\n✅ وصل هدف الصعود!\n\n📱 <i>مساعد ثاندر RS</i>`);
        alertsSent++;
      }
      if (stock.alertDown && price <= stock.alertDown) {
        await sendMessage(`🔴 <b>تنبيه نزول!</b>\n\n📌 <b>${stock.symbol}</b>\n💰 السعر: ${price.toFixed(2)} ج.م\n⚠️ تنبيهك: ${stock.alertDown} ج.م\n\n📱 <i>مساعد ثاندر RS</i>`);
        alertsSent++;
      }
    }
  }

  if (watchlist) {
    for (const [key, item] of Object.entries(watchlist)) {
      if (!item.symbol || !item.target) continue;
      const price = await getStockPrice(item.symbol);
      if (!price) continue;
      await updateFirebase(`watchlist/${key}`, { current: price });
      if (price <= item.target) {
        await sendMessage(`⭐ <b>تنبيه المراقبة!</b>\n\n📌 <b>${item.symbol}</b>\n💰 السعر: ${price.toFixed(2)} ج.م\n🎯 هدفك: ${item.target} ج.م\n\n✅ وصل سعر الشراء!\n\n📱 <i>مساعد ثاندر RS</i>`);
        alertsSent++;
      }
    }
  }

  console.log(`✅ Alerts check done. Sent: ${alertsSent}`);
  return alertsSent;
}

// ===== Handle Commands =====
async function handleCommand(text, chatId) {
  console.log(`📨 Command: ${text} from ${chatId}`);
  
  if (text === '/start' || text === '/help') {
    await sendMessage(
      `👋 <b>أهلاً يا Reda!</b>\n\n` +
      `🤖 أنا مساعد ثاندر RS Bot\n\n` +
      `<b>الأوامر:</b>\n` +
      `/check — فحص التنبيهات دلوقتي\n` +
      `/summary — ملخص المحفظة\n` +
      `/status — حالة البوت\n` +
      `/help — قائمة الأوامر\n\n` +
      `📱 <i>مساعد ثاندر RS</i>`, chatId
    );
  } else if (text === '/check') {
    await sendMessage('🔍 جاري فحص التنبيهات...', chatId);
    const count = await checkAlerts();
    await sendMessage(`✅ تم الفحص!\n${count > 0 ? `📨 تم إرسال ${count} تنبيه` : '🔕 مفيش تنبيهات دلوقتي'}`, chatId);
  } else if (text === '/summary') {
    const summary = await getPortfolioSummary();
    await sendMessage(summary, chatId);
  } else if (text === '/status') {
    await sendMessage(
      `✅ <b>البوت شغال!</b>\n\n` +
      `⏰ فحص كل ساعة\n` +
      `🌅 ملخص صباحي الساعة 9 ص\n` +
      `🔥 Firebase: متصل\n\n` +
      `📱 <i>مساعد ثاندر RS</i>`, chatId
    );
  }
}

// ===== Polling Loop =====
let offset = 0;
async function pollUpdates() {
  while (true) {
    try {
      const data = await getUpdates(offset);
      if (data.ok && data.result && data.result.length > 0) {
        for (const update of data.result) {
          offset = update.update_id + 1;
          const text = update.message?.text;
          const chatId = String(update.message?.chat?.id);
          if (text && chatId === CHAT_ID) {
            await handleCommand(text.split('@')[0], chatId);
          }
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ===== Morning Summary =====
async function checkMorning() {
  const now = new Date();
  const cairoHour = (now.getUTCHours() + 3) % 24;
  if (cairoHour === 9 && now.getUTCMinutes() === 0) {
    const summary = await getPortfolioSummary();
    await sendMessage(`🌅 <b>صباح الخير يا Reda!</b>\n\n${summary}\n\n🕙 البورصة بتفتح الساعة 10 ص\n📱 <i>مساعد ثاندر RS</i>`);
  }
}

// ===== Keepalive =====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('RS Thndr Bot 🚀');
}).listen(process.env.PORT || 3000);

// ===== Start =====
console.log('🚀 RS Thndr Bot Starting...');

sendMessage('🚀 <b>مساعد ثاندر Bot شغال!</b>\n\nهيراقب محفظتك كل ساعة 📊\n\nاكتب /help لقائمة الأوامر\n\n📱 <i>RS Suite</i>').then(() => {
  console.log('✅ Startup message sent');
});

// Start polling
pollUpdates();

// Run checks every hour
setInterval(checkAlerts, CHECK_INTERVAL);

// Morning check every minute
setInterval(checkMorning, 60000);

console.log('✅ Bot is running!');
