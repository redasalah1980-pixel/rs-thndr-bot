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
      `<b>🆓 أوامر مجانية:</b>\n` +
      `/check — فحص التنبيهات دلوقتي\n` +
      `/summary — ملخص المحفظة والمراقبة\n` +
      `/portfolio — تفاصيل المحفظة\n` +
      `/myanalyze — تحليل كل أسهمك\n` +
      `/gold — وضع الذهب بتاعك\n` +
      `/dollar — سعر الدولار دلوقتي\n` +
      `/analyze ADIB — تحليل سهم معين\n` +
      `/week — التقرير الأسبوعي\n` +
      `/status — حالة البوت\n\n` +
      `<b>🤖 أوامر بتستخدم AI (مدفوعة):</b>\n` +
      `/suggest — AI يوصي لكل سهم عندك\n` +
      `/market — تحليل السوق المصري\n` +
      `/learn — درس استثماري جديد\n\n` +
      `<b>⏰ تلقائي كل يوم (مجاني):</b>\n` +
      `🌅 9 ص — ملخص صباحي\n` +
      `📊 2 ظ — ملخص الإغلاق\n` +
      `🌙 9 م — ملخص مسائي\n` +
      `📅 جمعة 6م — تقرير أسبوعي\n` +
      `🥇 اثنين 9ص — تذكير الذهب\n\n` +
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
      await sendMessage('📊 جاري تحديث الأسعار...', chatId);
      const stocks = Object.values(portfolio);
      let msg = '💼 <b>تفاصيل محفظتك:</b>\n\n';
      let totalCost = 0, totalValue = 0;
      for (const s of stocks) {
        // جيب السعر الحي أولاً
        let livePrice = await getStockPrice(s.symbol);
        const currentPrice = (livePrice && livePrice > 0) ? livePrice : (s.currentPrice || s.buyPrice || 0);
        const source = (livePrice && livePrice > 0) ? '📡' : '💾';
        const cost = (s.buyPrice||0) * (s.shares||0);
        const value = currentPrice * (s.shares||0);
        const pnl = value - cost;
        const pct = cost > 0 ? (pnl/cost*100) : 0;
        totalCost += cost; totalValue += value;
        msg += `${pnl>=0?'📈':'📉'} <b>${s.symbol}</b> ${source}\n`;
        msg += `   شراء: ${s.buyPrice} | دلوقتي: ${currentPrice.toFixed(2)} ج.م\n`;
        msg += `   ${s.shares} سهم | ${pnl>=0?'+':''}${pnl.toFixed(2)} ج.م (${pct>=0?'+':''}${pct.toFixed(1)}%)\n\n`;
        // حدث Firebase بالسعر الجديد
        if (livePrice && livePrice > 0) {
          await updateFirebase(`portfolio/${Object.keys(portfolio).find(k => portfolio[k].symbol === s.symbol)}`, { currentPrice: livePrice });
        }
      }
      const totalPnl = totalValue - totalCost;
      const totalPct = totalCost > 0 ? (totalPnl/totalCost*100) : 0;
      msg += `─────────────────\n`;
      msg += `💰 الاستثمار: ${totalCost.toFixed(0)} ج.م\n`;
      msg += `📊 القيمة: ${totalValue.toFixed(0)} ج.م\n`;
      msg += `${totalPnl>=0?'✅':'❌'} ${totalPnl>=0?'+':''}${totalPnl.toFixed(2)} ج.م (${totalPct>=0?'+':''}${totalPct.toFixed(1)}%)\n`;
      msg += `\n📡 = Twelve Data | 💾 = آخر تحديث محفوظ\n\n`;
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
    await sendMessage('📊 جاري تحليل السوق المصري... (ممكن ياخد دقيقة)', chatId);
    if (!CLAUDE_API_KEY) {
      await sendMessage('⚠️ محتاج CLAUDE_API_KEY في Railway\n\n📱 <i>RS مساعد ثاندر</i>', chatId);
    } else {
      try {
        const analysis = await getDailyMarketAnalysis();
        const parts = analysis.split('━━━━━━━━━━━━━━\n');
        if (parts.length > 1 && parts[1] && parts[1].trim()) {
          await sendMessage(
            `📊 <b>تحليل السوق المصري</b>\n\n` + parts[0] +
            `\n⚠️ <i>استرشادي للتعلم</i>\n📱 <i>RS مساعد ثاندر</i>`, chatId
          );
          await sendMessage(
            `💼 <b>توصيات لأسهمك</b>\n\n` + parts[1] +
            `\n⚠️ <i>استرشادي للتعلم</i>\n📱 <i>RS مساعد ثاندر</i>`, chatId
          );
        } else {
          await sendMessage(
            `📊 <b>تحليل السوق المصري</b>\n\n` + analysis +
            `\n\n⚠️ <i>استرشادي للتعلم</i>\n📱 <i>RS مساعد ثاندر</i>`, chatId
          );
        }
      } catch(e) {
        console.error('Market analysis error:', e.message);
        await sendMessage('❌ خطأ في التحليل — جرب تاني بعد دقيقة', chatId);
      }
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

  } else if (text === '/week') {
    await sendWeeklyReport();

  } else if (text === '/learn') {
    await sendDailyLesson();

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
  const portfolio = await getFirebaseData('portfolio');
  const watchlist = await getFirebaseData('watchlist');

  let portfolioText = '';
  if (portfolio && Object.keys(portfolio).length > 0) {
    portfolioText = Object.values(portfolio).map(s =>
      `${s.symbol} (شراء ${s.buyPrice} | دلوقتي ${(s.currentPrice||s.buyPrice).toFixed(2)} ج.م)`
    ).join('\n');
  }

  let watchlistText = '';
  if (watchlist && Object.keys(watchlist).length > 0) {
    watchlistText = Object.values(watchlist).map(w =>
      `${w.symbol} (هدف ${w.target} | دلوقتي ${(w.current||0).toFixed(2)} ج.م)`
    ).join('\n');
  }

  // الجزء الأول — السوق العام
  const marketPrompt = `أنت محلل مالي متخصص في البورصة المصرية.
ابحث في الإنترنت عن أداء السوق المصري اليوم وقدم:

━━━━━━━━━━━━━━
📊 <b>مؤشر EGX30:</b> [الرقم + النسبة]
💵 <b>الدولار/جنيه:</b> [السعر]
🥇 <b>الذهب العالمي:</b> [دولار/أوقية]

━━━━━━━━━━━━━━
📰 <b>أهم أخبار اليوم:</b>
• [خبر 1 + تأثيره]
• [خبر 2 + تأثيره]
• [خبر 3 + تأثيره]

━━━━━━━━━━━━━━
🏭 <b>القطاعات:</b>
💪 الأقوى: [القطاع + السبب]
⚠️ الأضعف: [القطاع + السبب]

━━━━━━━━━━━━━━
🔍 <b>أسهم لافتة:</b>
📈 [سهم] +[نسبة]% — [السبب]
📈 [سهم] +[نسبة]% — [السبب]
📉 [سهم] -[نسبة]% — [السبب]

━━━━━━━━━━━━━━
🛒 <b>فرص شراء محتملة:</b>
• [سهم] عند [سعر] — [السبب]
• [سهم] عند [سعر] — [السبب]

🚫 <b>أسهم تجنبها:</b>
• [سهم] — [السبب]

💡 <b>توصية اليوم:</b>
[نصيحة عملية محددة]`;

  const marketResult = await callClaudeWithSearch(marketPrompt, 1500);

  // لو في محفظة أو مراقبة — رسالة تانية للتوصيات
  if (portfolioText || watchlistText) {
    const personalPrompt = `أنت مستشار استثماري. بناءً على أخبار السوق المصري اليوم:

${portfolioText ? `محفظة المستثمر:\n${portfolioText}\n` : ''}
${watchlistText ? `قائمة المراقبة:\n${watchlistText}\n` : ''}

ابحث عن أخبار هذه الأسهم تحديداً وقدم:

${portfolioText ? `💼 <b>توصيات المحفظة:</b>
[لكل سهم: احتفظ/بيع جزء/زيد + السبب]

` : ''}${watchlistText ? `⭐ <b>توصيات المراقبة:</b>
[لكل سهم: اشتري الآن/انتظر + السبب]` : ''}`;

    const personalResult = await callClaudeWithSearch(personalPrompt, 1000);
    return marketResult + '\n\n━━━━━━━━━━━━━━\n' + personalResult;
  }

  return marketResult;
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
  const cairoDow = (now.getUTCDay() + 1) % 7; // 0=أحد
  const mins = now.getUTCMinutes();
  if (mins !== 0) return;

  // 9 ص — صباحي (بدون AI)
  if (cairoHour === 9) {
    const summary = await buildFullSummary();
    await sendMessage(
      `🌅 <b>صباح الخير يا Reda!</b>\n\n` +
      summary +
      `\n🕙 البورصة بتفتح الساعة 10 الصبح\n` +
      `💡 راجع أسهمك وكن مستعد!\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`
    );
    console.log('✅ Morning summary sent');
  }

  // 2:30 ظ — إغلاق البورصة (بدون AI)
  if (cairoHour === 14) {
    const summary = await buildFullSummary();
    await sendMessage(
      `📊 <b>ملخص إغلاق البورصة!</b>\n\n` +
      summary +
      `\n🔒 البورصة أغلقت للنهارده\n` +
      `💡 راجع أداء أسهمك وخطط لبكره!\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`
    );
    console.log('✅ Closing summary sent');
  }

  // 9 م — مسائي (بدون AI)
  if (cairoHour === 21) {
    const summary = await buildFullSummary();
    await sendMessage(
      `🌙 <b>مساء الخير يا Reda!</b>\n\n` +
      summary +
      `\n\n💡 لو عايز توصيات AI اكتب /suggest\n` +
      `🕙 البورصة بتفتح بكره 10 ص\n\n` +
      `📱 <i>RS مساعد ثاندر</i>`
    );
    console.log('✅ Evening summary sent');
  }

  // الجمعة 6 م — تقرير أسبوعي (بدون AI)
  if (cairoHour === 18 && cairoDow === 5) {
    await sendWeeklyReport();
  }

  // الاثنين 9 ص — تذكير تحديث الذهب
  if (cairoHour === 9 && cairoDow === 1) {
    const goldData = await getFirebaseData('gold_portfolio');
    if (goldData && goldData.grams) {
      await sendMessage(
        `🥇 <b>تذكير أسبوعي — حدّث سعر الذهب</b>\n\n` +
        `افتح ثاندر → Thndr Gold → شوف السعر الحالي\n` +
        `بعدين افتح الأداة → محفظتي → 🥇 ذهب → حدّث\n\n` +
        `⚖️ عندك ${goldData.grams} جرام\n` +
        `📱 <i>RS مساعد ثاندر</i>`
      );
    }
  }
}

// ===== Weekly Report =====
async function sendWeeklyReport() {
  const portfolio = await getFirebaseData('portfolio');
  const goldData = await getFirebaseData('gold_portfolio');

  let msg = `📅 <b>التقرير الأسبوعي — جمعة مباركة يا Reda!</b>\n\n`;

  if (portfolio && Object.keys(portfolio).length > 0) {
    const stocks = Object.values(portfolio);
    let totalCost = 0, totalValue = 0;
    stocks.forEach(s => {
      totalCost += (s.buyPrice||0) * (s.shares||0);
      totalValue += (s.currentPrice||s.buyPrice||0) * (s.shares||0);
    });
    const pnl = totalValue - totalCost;
    const pct = totalCost > 0 ? (pnl/totalCost*100) : 0;
    msg += `💼 <b>أداء المحفظة هذا الأسبوع:</b>\n`;
    msg += `💰 القيمة: ${totalValue.toFixed(0)} ج.م\n`;
    msg += `${pnl>=0?'✅':'❌'} الربح/الخسارة: ${pnl>=0?'+':''}${pnl.toFixed(2)} ج.م (${pct>=0?'+':''}${pct.toFixed(1)}%)\n\n`;
  }

  if (goldData && goldData.grams) {
    const goldPnl = (goldData.currentPrice - goldData.buyPrice) * goldData.grams;
    const goldPct = goldData.buyPrice > 0 ? (goldPnl/goldData.buyPrice/goldData.grams*100) : 0;
    msg += `🥇 <b>الذهب:</b>\n`;
    msg += `${goldPnl>=0?'✅':'❌'} ${goldPnl>=0?'+':''}${goldPnl.toFixed(2)} ج.م\n\n`;
  }

  msg += `💡 <b>سؤال للتأمل:</b>\n`;
  msg += `هل قراراتك الأسبوع ده كانت صح؟\n`;
  msg += `افتح اليوميات في الأداة وراجع\n\n`;
  msg += `📱 <i>RS مساعد ثاندر</i>`;

  await sendMessage(msg);
  console.log('✅ Weekly report sent');
}

// ===== Daily Investment Lesson =====
const LESSONS = [
  {
    term: 'P/E — نسبة السعر للربح',
    def: `📌 <b>إيه هو؟</b>
بيقيسلك غلاء أو رخص السهم مقارنة بأرباح الشركة

📊 <b>الحساب:</b>
P/E = سعر السهم ÷ ربح السهم في السنة

🔢 <b>كيف تقرأها؟</b>
• أقل من 10 = السهم رخيص نسبياً ✅
• من 10 لـ 20 = سعر عادل 🟡
• أكتر من 20 = السهم غالي ⚠️

💡 <b>مثال عملي:</b>
ADIB سعره 52 ج.م وربحه 8.2 ج.م في السنة
P/E = 52 ÷ 8.2 = 6.3 ← رخيص!

⚠️ <b>مهم:</b>
قارن P/E بين أسهم نفس القطاع بس
P/E بنكي يختلف عن P/E عقاري`
  },
  {
    term: 'DCA — الشراء المتدرج',
    def: `📌 <b>إيه هو؟</b>
Dollar Cost Averaging — استراتيجية تقسيم المبلغ على فترات بدل شراء دفعة واحدة

🤔 <b>ليه مهم؟</b>
لو اشتريت بكل فلوسك في قمة السعر = خسارة كبيرة
لو قسّمت المبلغ = بتقلل الخطر

💡 <b>مثال عملي (1000 ج.م):</b>
❌ اشترى بـ 1000 كلها لما السعر 50 = 20 سهم
✅ اشترى بـ 333 كل أسبوع:
   أسبوع 1: سعر 50 → 6 أسهم
   أسبوع 2: سعر 45 → 7 أسهم
   أسبوع 3: سعر 48 → 6 أسهم
   المتوسط = 47.6 ج.م (أحسن!)

✅ <b>الفايدة:</b>
• بتقلل تأثير تذبذب الأسعار
• مش محتاج تتوقع القاع
• مناسب للمستثمر المبتدئ`
  },
  {
    term: 'وقف الخسارة — Stop Loss',
    def: `📌 <b>إيه هو؟</b>
سعر محدد مسبقاً تبيع عنده لو السهم نزل — لحماية رأس مالك من خسارة أكبر

🤔 <b>ليه مهم؟</b>
بدون وقف خسارة — ممكن سهم ينزل 50% وتفضل مستنياه!
بوقف خسارة — بتقطع الخسارة عند حد مقبول

📊 <b>كيف تحدده؟</b>
• المبتدئ: 10-15% تحت سعر الشراء
• المتحفظ: 7-10%
• المضارب: 5-7%

💡 <b>مثال عملي:</b>
اشتريت ADIB بـ 52 ج.م
وقف الخسارة عند 44 ج.م (-15%)
لو وصل 44 → بيعت وحفظت 85% من رأس مالك

⚠️ <b>تحذير:</b>
السهم ممكن يوصل وقف خسارتك ويطلع تاني
لو أساسيات الشركة كويسة — فكر قبل ما تبيع`
  },
  {
    term: 'T+0 و T+1 و T+2',
    def: `📌 <b>إيه معناها؟</b>
T = Transaction Day (يوم الصفقة)
الرقم بعده = عدد أيام التسوية

📅 <b>الشرح:</b>
• <b>T+0</b> = تقدر تبيع نفس اليوم اللي اشتريت فيه
• <b>T+1</b> = الأسهم بتظهر في محفظتك اليوم التاني
• <b>T+2</b> = الفلوس بتتسوى رسمياً بعد يومين

💡 <b>في ثاندر عملياً:</b>
اشتريت ADIB الأحد الساعة 11 ص
→ تقدر تبيعه نفس اليوم (T+0) ✅
→ الأسهم تظهر الاثنين (T+1)
→ التسوية الكاملة الثلاثاء (T+2)

⚠️ <b>مهم للمبتدئ:</b>
لو بعت وعندك أسهم T+1 — ممكن تلاقي مشكلة في التسوية
دايما تأكد من رصيدك قبل ما تبيع`
  },
  {
    term: 'حجم التداول — Volume',
    def: `📌 <b>إيه هو؟</b>
عدد الأسهم اللي اتباعت وبيعت في يوم واحد

📊 <b>الفرق بين حجم وقيمة التداول:</b>
• <b>حجم التداول</b> = عدد الأسهم (مثال: 500,000 سهم)
• <b>قيمة التداول</b> = المبلغ بالجنيه (مثال: 26 مليون ج.م)

🔍 <b>كيف تستخدمه؟</b>
✅ <b>سعر طالع + حجم عالي</b> = صعود حقيقي قوي
⚠️ <b>سعر طالع + حجم منخفض</b> = صعود ضعيف ومش موثوق
🔴 <b>سعر نازل + حجم عالي</b> = ضغط بيعي قوي ← خطر

💡 <b>مثال عملي:</b>
ADIB طلع +3% النهارده
لو حجم تداوله 5 مليون مقارنة بمتوسط 2 مليون
= الصعود حقيقي ومدعوم ✅`
  },
  {
    term: 'الأرباح الموزعة — Dividends',
    def: `📌 <b>إيه هي؟</b>
جزء من صافي أرباح الشركة بتوزعه على المساهمين نقداً

📊 <b>المصطلحات المهمة:</b>
• <b>ربح السهم</b>: كام ج.م لكل سهم
• <b>العائد التوزيعي</b>: الربح ÷ سعر السهم × 100
• <b>تاريخ الاستحقاق</b>: لازم تكون ماسك السهم قبله

💡 <b>مثال عملي:</b>
EAST سعره 18 ج.م — وزّع 1.5 ج.م للسهم
العائد التوزيعي = 1.5 ÷ 18 × 100 = 8.3% سنوياً
ده أحسن من فوايد بنكية كتير! ✅

🎯 <b>للمستثمر طويل المدى:</b>
الأرباح الموزعة بتضاف لعائدك الكلي
سهم طلع +10% ووزّع 5% = عائد حقيقي 15%`
  },
  {
    term: 'EPS — ربح السهم الواحد',
    def: `📌 <b>إيه هو؟</b>
Earnings Per Share
صافي ربح الشركة في السنة ÷ عدد الأسهم

📊 <b>الحساب:</b>
لو شركة ربحت 100 مليون ج.م
وعندها 10 مليون سهم
EPS = 100 ÷ 10 = 10 ج.م للسهم

🔍 <b>كيف تستخدمه؟</b>
✅ EPS بيزيد كل سنة = الشركة بتنمو ← ممتاز
⚠️ EPS ثابت = الشركة واقفة
🔴 EPS بينزل = الشركة في مشكلة

💡 <b>علاقته بالـ P/E:</b>
P/E = سعر السهم ÷ EPS
لو السهم بـ 52 والـ EPS = 8.2
P/E = 6.3 ← رخيص ✅

⚠️ <b>تحذير:</b>
ارتفاع EPS مرة واحدة مش كافي
دور على شركات فيها نمو EPS مستمر`
  },
  {
    term: 'التنويع — Diversification',
    def: `📌 <b>إيه هو؟</b>
توزيع استثمارك على أسهم وقطاعات مختلفة لتقليل المخاطر

🤔 <b>ليه مهم؟</b>
"لا تحط بيضك كله في سلة واحدة"
لو استثمرت كل فلوسك في سهم واحد ونزل 40% = كارثة

📊 <b>مثال تنويع كويس (10,000 ج.م):</b>
• 3,000 → بنوك (ADIB / COMI)
• 2,500 → عقارات (TMGH / PHDC)
• 2,500 → صناعة (SWDY / EAST)
• 2,000 → ذهب (Thndr Gold)

✅ <b>الفايدة:</b>
لو بنوك نزلت — ممكن صناعة تعوض
لو سوق نزل — الذهب بيطلع عادةً

⚠️ <b>لكن:</b>
التنويع الزيادة بيضيّع التركيز
3-5 أسهم كافية للمبتدئ`
  },
  {
    term: 'الدعم والمقاومة — Support & Resistance',
    def: `📌 <b>إيه هما؟</b>
مستويات سعرية بيتوقف عندها السهم أو بيرتد

📊 <b>الدعم Support:</b>
سعر السهم بيرفض ينزل تحته — كأنه "أرضية"
✅ لو السهم وصل الدعم ورجع يطلع = فرصة شراء

📊 <b>المقاومة Resistance:</b>
سعر السهم بيصعب يكسر فوقه — كأنه "سقف"
⚠️ لو السهم وصل المقاومة ونزل = فرصة بيع

💡 <b>مثال عملي:</b>
ADIB في آخر 6 شهور:
دعم عند 45 ج.م (اترتد منه 3 مرات)
مقاومة عند 58 ج.م (فشل يكسرها مرتين)
لو وصل 45 = فرصة شراء ✅
لو وصل 58 = فكر في جني ربح

🎯 <b>القاعدة الذهبية:</b>
اشتري قريب من الدعم — ابيع قريب من المقاومة`
  },
  {
    term: 'العائد الحقيقي — Total Return',
    def: `📌 <b>إيه هو؟</b>
العائد الكلي من استثمارك = ارتفاع السعر + الأرباح الموزعة مع بعض

🤔 <b>ليه مهم؟</b>
كتير ناس بيشوفوا بس ارتفاع السعر وينسوا الأرباح
الأرباح الموزعة جزء مهم جداً من العائد الحقيقي

💡 <b>مثال عملي:</b>
اشتريت EAST بـ 17 ج.م في يناير
السهم طلع لـ 19 ج.م (+11.8%)
ووزّع 1.5 ج.م أرباح (+8.8%)
العائد الحقيقي = 11.8 + 8.8 = <b>20.6%</b> ✅

📊 <b>مقارنة:</b>
فايدة البنك: 20-22% سنوياً (مضمونة)
أسهم كويسة: 25-40% سنوياً (مع مخاطرة)
الذهب: 15-20% سنوياً (تأمين)

🎯 <b>النصيحة:</b>
دايما احسب العائد الكلي مش بس ارتفاع السعر`
  },
];

let lessonIndex = 0;
async function sendDailyLesson() {
  const lesson = LESSONS[lessonIndex % LESSONS.length];
  lessonIndex++;
  await sendMessage(
    `📚 <b>درس اليوم — ${lesson.term}</b>\n\n` +
    lesson.def +
    `\n\n📱 <i>RS مساعد ثاندر</i>`
  );
  console.log('✅ Daily lesson sent');
}
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
