const https = require('https');
const http = require('http');

// ===== CONFIG =====
const BOT_TOKEN = '8984910077:AAETlpDzQm7jVFbuBoDD0zpcrzDWxcv9gdA';
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

// ===== Get Stock Price from Twelve Data =====
const TWELVE_DATA_KEY = 'de22aa3525b84767985c65db7b46b33d';

function getStockPrice(symbol) {
  return new Promise((resolve) => {
    // جرب XCAI أولاً (رمز البورصة المصرية في Twelve Data)
    const tryExchange = (exchange) => {
      return new Promise((res) => {
        const path = `/price?symbol=${symbol}&exchange=${exchange}&apikey=${TWELVE_DATA_KEY}`;
        const options = {
          hostname: 'api.twelvedata.com',
          path: path,
          method: 'GET',
          timeout: 10000
        };
        const req = https.request(options, (response) => {
          let data = '';
          response.on('data', chunk => data += chunk);
          response.on('end', () => {
            try {
              const json = JSON.parse(data);
              const price = json?.price ? parseFloat(json.price) : null;
              if (price && price > 0 && !isNaN(price)) {
                console.log(`✅ ${symbol}@${exchange}: ${price} ج.م`);
                res(price);
              } else {
                res(null);
              }
            } catch(e) { res(null); }
          });
        });
        req.on('error', () => res(null));
        req.on('timeout', () => { req.destroy(); res(null); });
        req.end();
      });
    };

    // جرب XCAI ثم EGX
    tryExchange('XCAI').then(price => {
      if (price) { resolve(price); return; }
      return tryExchange('EGX');
    }).then(price => {
      if (price) { resolve(price); return; }
      console.log(`⚠️ ${symbol}: لم يتم الحصول على السعر من Twelve Data`);
      resolve(null);
    }).catch(() => resolve(null));
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

      // تنبيه هدف الربح
      if (stock.alertUp && price >= stock.alertUp) {
        const profitPerShare = (price - stock.buyPrice).toFixed(2);
        const totalProfit = (profitPerShare * stock.shares).toFixed(2);
        const profitPct = ((price - stock.buyPrice) / stock.buyPrice * 100).toFixed(1);
        const halfShares = Math.floor(stock.shares / 2);
        const halfProfit = (profitPerShare * halfShares).toFixed(2);

        await sendMessage(
          `🟢 <b>تنبيه هدف الربح!</b>\n\n` +
          `📌 <b>${stock.symbol}</b> — ${stock.name||''}\n` +
          `💰 السعر الحالي: <b>${price.toFixed(2)} ج.م</b>\n` +
          `🎯 هدفك: ${stock.alertUp} ج.م\n` +
          `📈 الربح: +${profitPct}% (+${totalProfit} ج.م)\n\n` +
          `🤖 <b>خطة البيع المقترحة:</b>\n` +
          `• بيع ${halfShares} سهم دلوقتي → تأمين +${halfProfit} ج.م ✅\n` +
          `• احتفظ بـ ${stock.shares - halfShares} سهم للهدف التاني\n` +
          `• وقف خسارة للباقي: ${(price * 0.95).toFixed(2)} ج.م\n\n` +
          `📱 افتح ثاندر وقرر! <i>مساعد ثاندر RS</i>`
        );
        alertsSent++;
      }

      // تنبيه وقف الخسارة
      if (stock.alertDown && price <= stock.alertDown) {
        const lossPerShare = (price - stock.buyPrice).toFixed(2);
        const totalLoss = (Math.abs(lossPerShare) * stock.shares).toFixed(2);
        const lossPct = ((price - stock.buyPrice) / stock.buyPrice * 100).toFixed(1);

        await sendMessage(
          `🔴 <b>تنبيه وقف الخسارة!</b>\n\n` +
          `📌 <b>${stock.symbol}</b> — ${stock.name||''}\n` +
          `💰 السعر الحالي: <b>${price.toFixed(2)} ج.م</b>\n` +
          `⚠️ وقف خسارتك: ${stock.alertDown} ج.م\n` +
          `📉 الخسارة: ${lossPct}% (-${totalLoss} ج.م)\n\n` +
          `🤖 <b>نصيحة AI:</b>\n` +
          `• لو الخسارة أكتر من 15% → فكر في البيع فوراً\n` +
          `• لو السهم أساسياته كويسة → ممكن تصبر\n` +
          `• القرار النهائي ليك أنت!\n\n` +
          `📱 افتح ثاندر وقرر! <i>مساعد ثاندر RS</i>`
        );
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

      const diff = ((price - item.target) / item.target * 100);

      // وصل الهدف (نزل)
      if (price <= item.target) {
        await sendMessage(
          `⭐ <b>تنبيه المراقبة!</b>\n\n` +
          `📌 <b>${item.symbol}</b>${item.name ? ' — ' + item.name : ''}\n` +
          `💰 السعر الحالي: <b>${price.toFixed(2)} ج.م</b>\n` +
          `🎯 هدفك: ${item.target.toFixed(2)} ج.م\n\n` +
          `✅ <b>وصل سعر الشراء!</b> الفرصة جات 🚀\n` +
          `📱 افتح الأداة واضغط "اشتري ✅"\n\n` +
          `<i>RS مساعد ثاندر</i>`
        );
        alertsSent++;
      }

      // طلع كتير عن الهدف (+10%)
      else if (diff > 10) {
        await sendMessage(
          `⚠️ <b>تنبيه — ${item.symbol} طلع عن هدفك!</b>\n\n` +
          `💰 دلوقتي: <b>${price.toFixed(2)} ج.م</b>\n` +
          `🎯 هدفك كان: ${item.target.toFixed(2)} ج.م\n` +
          `📈 الفرق: +${diff.toFixed(1)}% فوق هدفك\n\n` +
          `🤖 <b>خياراتك:</b>\n` +
          `• اشتري جزء دلوقتي عند ${price.toFixed(2)}\n` +
          `• استنى تصحيح عند ${(price * 0.95).toFixed(2)} ج.م\n` +
          `• افتح الأداة → 🔄 حدّث التوصية\n\n` +
          `<i>RS مساعد ثاندر</i>`
        );
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
      `<b>الأوامر المتاحة:</b>\n` +
      `/check — فحص التنبيهات دلوقتي\n` +
      `/summary — ملخص المحفظة والمراقبة\n` +
      `/portfolio — تفاصيل المحفظة\n` +
      `/gold — وضع الذهب بتاعك\n` +
      `/dollar — سعر الدولار دلوقتي\n` +
      `/market — حالة السوق المصري\n` +
      `/analyze ADIB — تحليل سهم معين\n` +
      `/status — حالة البوت\n` +
      `/help — قائمة الأوامر\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`, chatId
    );

  } else if (text === '/check') {
    await sendMessage('🔍 جاري فحص التنبيهات...', chatId);
    const count = await checkAlerts();
    await sendMessage(`✅ تم الفحص!\n${count > 0 ? `📨 تم إرسال ${count} تنبيه` : '🔕 مفيش تنبيهات دلوقتي'}`, chatId);

  } else if (text === '/summary') {
    const summary = await buildFullSummary();
    await sendMessage('📊 <b>ملخص المحفظة والمراقبة</b>\n\n' + summary + '\n📱 <i>RS مساعد ثاندر</i>', chatId);

  } else if (text === '/portfolio') {
    const portfolio = await getFirebaseData('portfolio');
    if (!portfolio || Object.keys(portfolio).length === 0) {
      await sendMessage('💼 المحفظة فاضية دلوقتي\nأضف أسهمك من الأداة', chatId);
    } else {
      const stocks = Object.values(portfolio);
      let msg = '💼 <b>تفاصيل محفظتك:</b>\n\n';
      let totalCost = 0, totalValue = 0;
      for (const s of stocks) {
        const cost = (s.buyPrice||0) * (s.shares||0);
        const value = (s.currentPrice||s.buyPrice||0) * (s.shares||0);
        const pnl = value - cost;
        const pct = cost > 0 ? (pnl/cost*100) : 0;
        totalCost += cost; totalValue += value;
        msg += `${pnl>=0?'📈':'📉'} <b>${s.symbol}</b>\n`;
        msg += `   شراء: ${s.buyPrice} | دلوقتي: ${(s.currentPrice||s.buyPrice).toFixed(2)} ج.م\n`;
        msg += `   ${s.shares} سهم | ${pnl>=0?'+':''}${pnl.toFixed(2)} ج.م (${pct>=0?'+':''}${pct.toFixed(1)}%)\n\n`;
      }
      const totalPnl = totalValue - totalCost;
      const totalPct = totalCost > 0 ? (totalPnl/totalCost*100) : 0;
      msg += `─────────────────\n`;
      msg += `💰 الاستثمار: ${totalCost.toFixed(0)} ج.م\n`;
      msg += `📊 القيمة: ${totalValue.toFixed(0)} ج.م\n`;
      msg += `${totalPnl>=0?'✅':'❌'} ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} ج.م (${totalPct>=0?'+':''}${totalPct.toFixed(1)}%)\n\n`;
      msg += `📱 <i>RS مساعد ثاندر</i>`;
      await sendMessage(msg, chatId);
    }

  } else if (text === '/gold') {
    const goldData = await getFirebaseData('gold_portfolio');
    if (!goldData || !goldData.grams) {
      await sendMessage('🥇 مش أضفت ذهبك لسه\nأضفه من الأداة في تبويب 🥇 ذهب', chatId);
    } else {
      const goldBuy = goldData.buyPrice * goldData.grams;
      const goldCurrent = goldData.currentPrice * goldData.grams;
      const goldPnl = goldCurrent - goldBuy;
      const goldPct = goldBuy > 0 ? (goldPnl/goldBuy*100) : 0;
      await sendMessage(
        `🥇 <b>وضع ذهبك:</b>\n\n` +
        `⚖️ ${goldData.grams} جرام\n` +
        `💰 متوسط الشراء: ${goldData.buyPrice.toFixed(2)} ج.م/جرام\n` +
        `📊 السعر الحالي: ${goldData.currentPrice.toFixed(2)} ج.م/جرام\n\n` +
        `💵 تكلفة: ${goldBuy.toFixed(2)} ج.م\n` +
        `📈 القيمة: ${goldCurrent.toFixed(2)} ج.م\n` +
        `${goldPnl>=0?'✅':'❌'} ${goldPnl>=0?'+':''}${goldPnl.toFixed(2)} ج.م (${goldPct>=0?'+':''}${goldPct.toFixed(1)}%)\n\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    }

  } else if (text === '/market') {
    const now = new Date();
    const cairoHour = (now.getUTCHours() + 3) % 24;
    const day = now.getDay();
    const isWeekday = day >= 0 && day <= 4;
    const isOpen = isWeekday && cairoHour >= 10 && cairoHour < 14.5;
    await sendMessage(
      `📊 <b>حالة السوق المصري:</b>\n\n` +
      `${isOpen ? '🟢 البورصة مفتوحة دلوقتي' : '🔴 البورصة مغلقة'}\n\n` +
      `🕙 أوقات التداول: 10 ص — 2:30 م\n` +
      `📅 أيام العمل: الأحد — الخميس\n\n` +
      `${!isOpen && isWeekday && cairoHour < 10 ? `⏰ بيفتح بعد ${(10-cairoHour).toFixed(0)} ساعة تقريباً\n\n` : ''}` +
      `💡 للأسعار اللحظية افتح ثاندر\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`, chatId
    );

  } else if (text && text.startsWith('/analyze ')) {
    const symbol = text.replace('/analyze ', '').trim().toUpperCase();
    if (!symbol) {
      await sendMessage('⚠️ مثال: /analyze ADIB', chatId);
    } else {
      await sendMessage(`🔍 جاري تحليل <b>${symbol}</b>...`, chatId);
      const price = await getStockPrice(symbol);
      if (!price) {
        await sendMessage(`❌ مش قادر أجيب سعر ${symbol}\nتأكد من الرمز وجرب تاني`, chatId);
      } else {
        const watchlist = await getFirebaseData('watchlist');
        const portfolio = await getFirebaseData('portfolio');
        let extra = '';
        if (watchlist) {
          const w = Object.values(watchlist).find(w => w.symbol === symbol);
          if (w) {
            const diff = ((price - w.target) / w.target * 100);
            extra += `\n⭐ في مراقبتك عند: ${w.target} ج.م\n`;
            extra += diff > 0 ? `📈 فوق هدفك بـ +${diff.toFixed(1)}%\n` : `✅ تحت هدفك — فرصة شراء!\n`;
          }
        }
        if (portfolio) {
          const s = Object.values(portfolio).find(s => s.symbol === symbol);
          if (s) {
            const pnl = (price - s.buyPrice) * s.shares;
            const pct = (price - s.buyPrice) / s.buyPrice * 100;
            extra += `\n💼 في محفظتك: ${s.shares} سهم بـ ${s.buyPrice} ج.م\n`;
            extra += `${pnl>=0?'✅':'❌'} ${pnl>=0?'+':''}${pnl.toFixed(2)} ج.م (${pct>=0?'+':''}${pct.toFixed(1)}%)\n`;
          }
        }
        await sendMessage(
          `📊 <b>تحليل ${symbol}</b>\n\n` +
          `💰 السعر الحالي: <b>${price.toFixed(2)} ج.م</b>\n` +
          `📡 المصدر: Twelve Data (تأخير 15 دقيقة)` +
          extra +
          `\n💡 للتحليل الكامل مع AI → افتح الأداة\n\n` +
          `📱 <i>RS مساعد ثاندر</i>`, chatId
        );
      }
    }

  } else if (text === '/dollar') {
    await sendMessage('💵 جاري جلب سعر الدولار...', chatId);
    const rate = await getUSDRate();
    if (!rate) {
      await sendMessage('❌ مش قادر أجيب السعر دلوقتي — جرب تاني', chatId);
    } else {
      await sendMessage(
        `💵 <b>سعر الدولار الأمريكي</b>\n\n` +
        `1 دولار = <b>${rate.toFixed(2)} جنيه مصري</b>\n\n` +
        `📡 المصدر: Twelve Data\n` +
        `🕐 تأخير 15 دقيقة\n\n` +
        `💡 <b>أهميته للمستثمر:</b>\n` +
        `• الذهب مرتبط بالدولار مباشرة\n` +
        `• أسهم التصدير بتستفيد من ارتفاعه\n` +
        `• ارتفاعه = تضخم في المواد المستوردة\n\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    }

  } else if (text === '/status') {
    await sendMessage(
      `✅ <b>البوت شغال!</b>\n\n` +
      `⏰ فحص تنبيهات كل ساعة\n` +
      `🌅 ملخص صباحي الساعة 9 ص\n` +
      `📊 ملخص إغلاق الساعة 2 ظ\n` +
      `🌙 ملخص مسائي الساعة 9 م\n` +
      `🔥 Firebase: متصل\n` +
      `📡 Twelve Data: متصل\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`, chatId
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

// ===== Get USD/EGP Rate =====
async function getUSDRate() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.twelvedata.com',
      path: `/price?symbol=USD/EGP&apikey=${TWELVE_DATA_KEY}`,
      method: 'GET',
      timeout: 8000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const rate = json?.price ? parseFloat(json.price) : null;
          resolve(rate);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
async function buildFullSummary() {
  const portfolio = await getFirebaseData('portfolio');
  const watchlist = await getFirebaseData('watchlist');
  const goldData = await getFirebaseData('gold_portfolio');
  const usdRate = await getUSDRate();

  let msg = '';

  // سعر الدولار
  if (usdRate) {
    msg += `💵 <b>الدولار/جنيه:</b> ${usdRate.toFixed(2)} ج.م\n\n`;
  }

  // المحفظة
  if (portfolio && Object.keys(portfolio).length > 0) {
    const stocks = Object.values(portfolio);
    let totalCost = 0, totalValue = 0;
    let stockLines = '';
    for (const s of stocks) {
      const cost = (s.buyPrice || 0) * (s.shares || 0);
      const value = (s.currentPrice || s.buyPrice || 0) * (s.shares || 0);
      const pnl = value - cost;
      const pct = cost > 0 ? (pnl / cost * 100) : 0;
      totalCost += cost;
      totalValue += value;
      const arrow = pnl >= 0 ? '📈' : '📉';
      stockLines += `${arrow} <b>${s.symbol}</b> — ${(s.currentPrice || s.buyPrice).toFixed(2)} ج.م (${pnl >= 0 ? '+' : ''}${pct.toFixed(1)}%)\n`;
    }
    const totalPnl = totalValue - totalCost;
    const totalPct = totalCost > 0 ? (totalPnl / totalCost * 100) : 0;
    msg += `💼 <b>المحفظة (${stocks.length} أسهم):</b>\n`;
    msg += stockLines;
    msg += `\n💰 الإجمالي: ${totalValue.toFixed(0)} ج.م\n`;
    msg += `${totalPnl >= 0 ? '✅' : '❌'} ربح/خسارة: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} ج.م (${totalPct >= 0 ? '+' : ''}${totalPct.toFixed(1)}%)\n`;
  } else {
    msg += `💼 <b>المحفظة:</b> فاضية\n`;
  }

  // الذهب
  if (goldData && goldData.grams) {
    const goldBuy = goldData.buyPrice * goldData.grams;
    const goldCurrent = goldData.currentPrice * goldData.grams;
    const goldPnl = goldCurrent - goldBuy;
    const goldPct = goldBuy > 0 ? (goldPnl / goldBuy * 100) : 0;
    msg += `\n🥇 <b>الذهب:</b>\n`;
    msg += `${goldPnl >= 0 ? '📈' : '📉'} ${goldData.grams} جرام — ${goldCurrent.toFixed(2)} ج.م\n`;
    msg += `${goldPnl >= 0 ? '✅' : '❌'} ربح/خسارة: ${goldPnl >= 0 ? '+' : ''}${goldPnl.toFixed(2)} ج.م (${goldPct >= 0 ? '+' : ''}${goldPct.toFixed(1)}%)\n`;
    msg += `💰 سعر الجرام: ${goldData.currentPrice.toFixed(2)} ج.م\n`;
  }

  // المراقبة
  if (watchlist && Object.keys(watchlist).length > 0) {
    const watches = Object.values(watchlist);
    msg += `\n⭐ <b>المراقبة (${watches.length} أسهم):</b>\n`;
    for (const w of watches) {
      const current = w.current || 0;
      const target = w.target || 0;
      const reached = current <= target;
      const diff = target > 0 ? ((current - target) / target * 100) : 0;
      const close = diff <= 10 && diff > 0;

      let status = reached ? '🟢' : close ? '🟡' : '⏳';
      let statusText = reached ? 'وصل الهدف!' : close ? 'قريب جداً!' : 'لسه بعيد';

      msg += `${status} <b>${w.symbol}</b>${w.name ? ' — ' + w.name : ''}\n`;
      msg += `   💰 دلوقتي: <b>${current.toFixed(2)} ج.م</b>\n`;
      msg += `   🎯 هدفك: ${target.toFixed(2)} ج.م\n`;
      msg += `   📊 ${statusText} (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}%)\n`;
    }
  }

  return msg;
}

// ===== Three Daily Summaries =====
async function checkDailySummaries() {
  const now = new Date();
  const cairoHour = (now.getUTCHours() + 3) % 24;
  const mins = now.getUTCMinutes();
  if (mins !== 0) return;

  // 9 ص — صباحي
  if (cairoHour === 9) {
    const summary = await buildFullSummary();
    await sendMessage(
      `🌅 <b>صباح الخير يا Reda!</b>\n\n` +
      summary +
      `\n🕙 البورصة بتفتح الساعة 10 الصبح\n` +
      `💡 راجع أسهمك وكن مستعد!\n\n` +
      `📱 <i>مساعد ثاندر RS</i>`
    );
    console.log('✅ Morning summary sent');
  }

  // 2:30 ظ — إغلاق البورصة
  if (cairoHour === 14) {
    const summary = await buildFullSummary();
    await sendMessage(
      `📊 <b>ملخص إغلاق البورصة!</b>\n\n` +
      summary +
      `\n🔒 البورصة أغلقت للنهارده\n` +
      `💡 راجع أداء أسهمك وخطط لبكره!\n\n` +
      `📱 <i>مساعد ثاندر RS</i>`
    );
    console.log('✅ Closing summary sent');
  }

  // 9 م — مسائي
  if (cairoHour === 21) {
    const summary = await buildFullSummary();
    await sendMessage(
      `🌙 <b>مساء الخير يا Reda!</b>\n\n` +
      summary +
      `\n💡 نصيحة المساء:\nراجع قراراتك وخطط لتحليلات بكره\n` +
      `🕙 البورصة بتفتح بكره الساعة 10 ص\n\n` +
      `📱 <i>مساعد ثاندر RS</i>`
    );
    console.log('✅ Evening summary sent');
  }
}

// ===== Keepalive =====
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('RS Thndr Bot 🚀');
}).listen(process.env.PORT || 3000);

// ===== Start =====
console.log('🚀 RS Thndr Bot Starting...');

sendMessage('🚀 <b>مساعد ثاندر Bot شغال!</b>\n\nهيراقب محفظتك كل ساعة 📊\n\nاكتب /help لقائمة الأوامر\n\n📱 <i>RS مساعد ثاندر</i>').then(() => {
  console.log('✅ Startup message sent');
});

// Start polling
pollUpdates();

// Run checks every hour
setInterval(checkAlerts, CHECK_INTERVAL);

// Daily summaries check every minute
setInterval(checkDailySummaries, 60000);

console.log('✅ Bot is running!');
