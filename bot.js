const https = require('https');
const http = require('http');

// ===== CONFIG =====
const BOT_TOKEN = '8984910077:AAETlpDzQm7jVFbuBoDD0zpcrzDWxcv9gdA';
const CHAT_ID = '344402775';
const FIREBASE_URL = 'https://rs-thndr-assistant-default-rtdb.europe-west1.firebasedatabase.app';
const CHECK_INTERVAL = 60 * 60 * 1000;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

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
      `/myanalyze — تحليل كل أسهمك\n` +
      `/suggest — 🤖 AI يوصي لكل سهم عندك\n` +
      `/gold — وضع الذهب بتاعك\n` +
      `/dollar — سعر الدولار دلوقتي\n` +
      `/market — 📊 تحليل السوق المصري اليوم\n` +
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

  } else if (text === '/market' || text === '/market_analysis') {
    await sendMessage('📊 جاري تحليل السوق المصري...', chatId);
    if (!CLAUDE_API_KEY) {
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
        `💡 للتحليل الكامل أضف CLAUDE_API_KEY\n\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    } else {
      const analysis = await getDailyMarketAnalysis();
      await sendMessage(
        `📊 <b>تحليل السوق المصري اليوم</b>\n\n` +
        analysis +
        `\n\n⚠️ <i>استرشادي فقط — ليس توصية مالية رسمية</i>\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    }

  } else if (text && (text === '/analyze' || text.startsWith('/analyze '))) {
    const parts = text.split(' ');
    const symbol = parts[1] ? parts[1].trim().toUpperCase() : null;
    if (!symbol) {
      await sendMessage(
        `📊 <b>تحليل سهم</b>\n\n` +
        `اكتب الأمر مع رمز السهم:\n` +
        `<code>/analyze ADIB</code>\n` +
        `<code>/analyze TMGH</code>\n` +
        `<code>/analyze COMI</code>\n\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    } else {
      await sendMessage(`🔍 جاري تحليل <b>${symbol}</b>...`, chatId);
      let price = null;
      let priceSource = 'Twelve Data (تأخير 15 دقيقة)';

      // أولاً — جرب Twelve Data
      try {
        price = await getStockPrice(symbol);
        console.log(`/analyze ${symbol}: price=${price}`);
      } catch(e) {
        console.error(`/analyze error: ${e.message}`);
      }

      // لو مش لاقي — جرب من Firebase
      if (!price) {
        const fbPortfolio = await getFirebaseData('portfolio');
        const fbWatchlist = await getFirebaseData('watchlist');
        if (fbPortfolio) {
          const s = Object.values(fbPortfolio).find(s => s.symbol === symbol);
          if (s && s.currentPrice) { price = s.currentPrice; priceSource = 'آخر تحديث في محفظتك'; }
        }
        if (!price && fbWatchlist) {
          const w = Object.values(fbWatchlist).find(w => w.symbol === symbol);
          if (w && w.current) { price = w.current; priceSource = 'آخر تحديث في مراقبتك'; }
        }
      }

      if (!price) {
        await sendMessage(
          `⚠️ <b>${symbol}</b>\n\n` +
          `مش قادر أجيب السعر دلوقتي\n\n` +
          `الأسباب المحتملة:\n` +
          `• السهم مش في Twelve Data المجاني\n` +
          `• البورصة مغلقة دلوقتي\n` +
          `• مش في محفظتك أو مراقبتك\n\n` +
          `💡 حدّث السعر يدوياً من الأداة وجرب تاني`, chatId
        );
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
          `💰 السعر: <b>${price.toFixed(2)} ج.م</b>\n` +
          `📡 ${priceSource}` +
          extra +
          `\n\n💡 للتحليل الكامل مع AI → افتح الأداة\n\n` +
          `📱 <i>RS مساعد ثاندر</i>`, chatId
        );
      }
    }

  } else if (text === '/suggest') {
    if (!CLAUDE_API_KEY) {
      await sendMessage(
        `⚠️ <b>محتاج Claude API Key</b>\n\n` +
        `أضف الـ Key في Railway:\n` +
        `Settings → Variables → CLAUDE_API_KEY\n\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    } else {
      await sendMessage('🤖 AI بيحلل محفظتك ويجهز التوصيات...', chatId);
      const suggestions = await getAISuggestions();
      await sendMessage(
        `💡 <b>توصيات AI لمحفظتك:</b>\n\n` +
        suggestions +
        `\n\n⚠️ هذه توصيات استرشادية — القرار النهائي ليك أنت\n\n` +
        `📱 <i>RS مساعد ثاندر</i>`, chatId
      );
    }

  } else if (text === '/myanalyze') {
    await sendMessage('🔍 جاري تحليل كل أسهمك...', chatId);

    const portfolio = await getFirebaseData('portfolio');
    const watchlist = await getFirebaseData('watchlist');
    let msg = '📊 <b>تحليل أسهمك كلها:</b>\n\n';
    let hasAny = false;

    // أسهم المحفظة
    if (portfolio && Object.keys(portfolio).length > 0) {
      msg += '💼 <b>المحفظة:</b>\n';
      for (const s of Object.values(portfolio)) {
        if (!s.symbol) continue;
        hasAny = true;
        // جرب تجيب سعر جديد
        let livePrice = await getStockPrice(s.symbol);
        const currentPrice = livePrice || s.currentPrice || s.buyPrice;
        const pnl = (currentPrice - s.buyPrice) * s.shares;
        const pct = (currentPrice - s.buyPrice) / s.buyPrice * 100;
        const source = livePrice ? '📡' : '💾';

        msg += `${pnl>=0?'📈':'📉'} <b>${s.symbol}</b> ${source}\n`;
        msg += `   💰 ${currentPrice.toFixed(2)} ج.م\n`;
        msg += `   ${pnl>=0?'✅':'❌'} ${pnl>=0?'+':''}${pnl.toFixed(2)} ج.م (${pct>=0?'+':''}${pct.toFixed(1)}%)\n`;
        if (s.alertUp && currentPrice >= s.alertUp) msg += `   🎯 وصل هدف الربح!\n`;
        if (s.alertDown && currentPrice <= s.alertDown) msg += `   🛑 وصل وقف الخسارة!\n`;
        msg += '\n';
      }
    }

    // أسهم المراقبة
    if (watchlist && Object.keys(watchlist).length > 0) {
      msg += '⭐ <b>المراقبة:</b>\n';
      for (const w of Object.values(watchlist)) {
        if (!w.symbol) continue;
        hasAny = true;
        let livePrice = null;
        try { livePrice = await getStockPrice(w.symbol); } catch(e) {}
        // استخدم السعر المحفوظ لو Twelve Data مش شغال
        const currentPrice = (livePrice && livePrice > 0) ? livePrice : (w.current || 0);
        const source = (livePrice && livePrice > 0) ? '📡' : '💾';
        const diff = w.target > 0 && currentPrice > 0 ? ((currentPrice - w.target) / w.target * 100) : null;
        const status = diff === null ? '⏳' : diff <= 0 ? '🟢' : diff <= 10 ? '🟡' : '⏳';
        const statusText = diff === null ? 'سعر غير محدث' : diff <= 0 ? 'وصل الهدف! ✅' : diff <= 10 ? 'قريب جداً!' : 'لسه بعيد';

        msg += `${status} <b>${w.symbol}</b>${w.name ? ' — ' + w.name : ''} ${source}\n`;
        msg += currentPrice > 0 ? `   💰 دلوقتي: ${currentPrice.toFixed(2)} ج.م\n` : `   💰 السعر: غير محدث\n`;
        msg += `   🎯 هدفك: ${(w.target||0).toFixed(2)} ج.م\n`;
        if (diff !== null) msg += `   📊 ${statusText} (${diff>=0?'+':''}${diff.toFixed(1)}%)\n`;
        msg += '\n';
      }
    }

    // الذهب
    const goldData = await getFirebaseData('gold_portfolio');
    if (goldData && goldData.grams) {
      hasAny = true;
      const goldBuy = goldData.buyPrice * goldData.grams;
      const goldCurrent = goldData.currentPrice * goldData.grams;
      const goldPnl = goldCurrent - goldBuy;
      const goldPct = goldBuy > 0 ? (goldPnl/goldBuy*100) : 0;
      msg += `🥇 <b>الذهب:</b>\n`;
      msg += `   ⚖️ ${goldData.grams} جرام\n`;
      msg += `   💰 ${goldData.currentPrice.toFixed(2)} ج.م/جرام\n`;
      msg += `   ${goldPnl>=0?'✅':'❌'} ${goldPnl>=0?'+':''}${goldPnl.toFixed(2)} ج.م (${goldPct>=0?'+':''}${goldPct.toFixed(1)}%)\n\n`;
    }

    if (!hasAny) {
      await sendMessage('📊 مفيش أسهم في محفظتك أو مراقبتك دلوقتي', chatId);
    } else {
      msg += `📡 المصدر: Twelve Data أو آخر تحديث\n`;
      msg += `\n💡 للتحليل الكامل مع AI → افتح الأداة\n\n`;
      msg += `📱 <i>RS مساعد ثاندر</i>`;
      await sendMessage(msg, chatId);
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

// ===== Claude API =====
function callClaude(prompt) {
  return new Promise((resolve) => {
    if (!CLAUDE_API_KEY) { resolve('مفيش API Key'); return; }
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    const bodyBuffer = Buffer.from(body, 'utf8');
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': bodyBuffer.length
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          console.log('Claude response status:', res.statusCode);
          const json = JSON.parse(data);
          if (json.error) {
            console.error('Claude error:', json.error);
            resolve('خطأ: ' + (json.error.message || 'مش قادر أحلل'));
            return;
          }
          const text = json?.content?.[0]?.text || 'مش قادر أحلل دلوقتي';
          resolve(text);
        } catch(e) {
          console.error('Claude parse error:', e.message, 'data:', data.slice(0,200));
          resolve('خطأ في التحليل');
        }
      });
    });
    req.on('error', (e) => {
      console.error('Claude request error:', e.message);
      resolve('خطأ في الاتصال: ' + e.message);
    });
    req.write(bodyBuffer);
    req.end();
  });
}

// ===== AI Suggestions =====
async function getAISuggestions() {
  const portfolio = await getFirebaseData('portfolio');
  const watchlist = await getFirebaseData('watchlist');

  if ((!portfolio || Object.keys(portfolio).length === 0) &&
      (!watchlist || Object.keys(watchlist).length === 0)) {
    return 'مفيش أسهم في محفظتك أو مراقبتك دلوقتي';
  }

  let portfolioText = '';
  if (portfolio && Object.keys(portfolio).length > 0) {
    portfolioText = Object.values(portfolio).map(s => {
      const pnl = ((s.currentPrice||s.buyPrice) - s.buyPrice) / s.buyPrice * 100;
      return `${s.symbol}: شراء ${s.buyPrice} | دلوقتي ${(s.currentPrice||s.buyPrice).toFixed(2)} | ${pnl>=0?'+':''}${pnl.toFixed(1)}% | هدف: ${s.alertUp||'—'} | وقف: ${s.alertDown||'—'}`;
    }).join('\n');
  }

  let watchText = '';
  if (watchlist && Object.keys(watchlist).length > 0) {
    watchText = Object.values(watchlist).map(w => {
      const diff = w.target > 0 ? ((w.current-w.target)/w.target*100).toFixed(1) : '—';
      return `${w.symbol}: هدف شراء ${w.target} | دلوقتي ${(w.current||0).toFixed(2)} | ${diff}%`;
    }).join('\n');
  }

  const prompt = `أنت مستشار استثماري متخصص في البورصة المصرية.

محفظة المستثمر:
${portfolioText || 'فاضية'}

أسهم المراقبة:
${watchText || 'فاضية'}

بناءً على هذه البيانات، قدم توصيات مختصرة وعملية باللغة العربية:

لكل سهم في المحفظة:
🔴 بيع / 🟡 احتفظ / 🟢 زيد — والسبب في جملة واحدة

لكل سهم في المراقبة:
✅ اشتري دلوقتي / ⏳ استنى / ❌ تجنب — والسبب في جملة واحدة

في النهاية: نصيحة عامة واحدة للمحفظة كلها.
اجعل ردك مختصراً ومباشراً.`;

  return await callClaude(prompt);
}
// ===== Claude API with Web Search =====
function callClaudeWithSearch(prompt, maxTokens) {
  maxTokens = maxTokens || 1000;
  return new Promise((resolve) => {
    if (!CLAUDE_API_KEY) { resolve('مفيش API Key'); return; }
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: prompt }]
    });
    const bodyBuffer = Buffer.from(body, 'utf8');
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': bodyBuffer.length
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { resolve('خطأ: ' + json.error.message); return; }
          let text = '';
          if (json.content) json.content.forEach(b => { if (b.type === 'text') text += b.text; });
          resolve(text || 'مش قادر أحلل دلوقتي');
        } catch(e) { resolve('خطأ في التحليل'); }
      });
    });
    req.on('error', (e) => { resolve('خطأ: ' + e.message); });
    req.write(bodyBuffer);
    req.end();
  });
}

// ===== Daily Market Analysis =====
async function getDailyMarketAnalysis() {
  const prompt = `أنت محلل مالي متخصص في البورصة المصرية EGX. مهمتك تحليل السوق وتقديم توصيات محددة بأسماء أسهم.

ابحث في الإنترنت الآن عن:
1. أداء مؤشر EGX30 آخر جلسة تداول بالأرقام
2. أهم أخبار البورصة المصرية اليوم
3. القطاعات الأقوى والأضعف
4. أسهم ارتفعت أو انخفضت بشكل لافت
5. أي أرباح شركات أو قرارات مؤثرة

قدم التقرير التالي كاملاً باللغة العربية:

📊 <b>مؤشر EGX30:</b>
[الرقم والنسبة المئوية للتغيير]

📰 <b>أهم خبر اليوم:</b>
[الخبر وتأثيره المباشر على السوق]

💪 <b>أقوى قطاع:</b> [اسم القطاع] — [السبب]
⚠️ <b>أضعف قطاع:</b> [اسم القطاع] — [السبب]

🛒 <b>أسهم مقترحة للشراء الآن:</b>
• [رمز السهم] — [السعر التقريبي] — [السبب بجملة]
• [رمز السهم] — [السعر التقريبي] — [السبب بجملة]
• [رمز السهم] — [السعر التقريبي] — [السبب بجملة]

📈 <b>أسهم متوقع لها صعود قريب:</b>
• [رمز السهم] — [السبب والهدف المتوقع]
• [رمز السهم] — [السبب والهدف المتوقع]

🚫 <b>أسهم يُفضل تجنبها الآن:</b>
• [رمز السهم] — [السبب]

💡 <b>توصية اليوم:</b>
[نصيحة استثمارية عملية ومحددة]

⚠️ استرشادي للتعلم فقط — ليس توصية مالية رسمية`;

  return await callClaudeWithSearch(prompt, 1500);
}

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

  // 10 ص — تحليل السوق مع الافتتاح
  if (cairoHour === 10 && CLAUDE_API_KEY) {
    try {
      const analysis = await getDailyMarketAnalysis();
      await sendMessage(
        `📊 <b>تحليل السوق المصري — افتتاح اليوم</b>\n\n` +
        analysis +
        `\n\n📱 <i>RS مساعد ثاندر</i>`
      );
      console.log('✅ Market analysis sent');
    } catch(e) { console.log('Market analysis error:', e.message); }
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

  // 9 م — مسائي + توصية AI
  if (cairoHour === 21) {
    const summary = await buildFullSummary();
    let aiTip = '';
    if (CLAUDE_API_KEY) {
      try {
        const suggestions = await getAISuggestions();
        aiTip = `\n\n💡 <b>توصية AI المسائية:</b>\n${suggestions}`;
      } catch(e) { console.log('AI suggest error:', e.message); }
    }
    await sendMessage(
      `🌙 <b>مساء الخير يا Reda!</b>\n\n` +
      summary +
      aiTip +
      `\n\n🕙 البورصة بتفتح بكره 10 ص\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`
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
