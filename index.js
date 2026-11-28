const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const pino = require('pino');
const http = require('http');
const NodeCache = require('node-cache');

const BOT_NAME = 'طارق';
const msgRetryCounterCache = new NodeCache();
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

// ===== سيرفر HTTP عشان Render =====
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`${BOT_NAME} شغال ✅`);
}).listen(PORT, () => {
  console.log(`🌐 ${BOT_NAME} على بورت ${PORT}`);
});

// ===== ذاكرة المحادثات =====
const memory = new Map();

function getMemory(userId) {
  if (!memory.has(userId)) memory.set(userId, []);
  return memory.get(userId);
}

// ===== الكلمات السيئة =====
const BAD_WORDS = [
  'كلب','حمار','غبي','احمق','معرص','ابن الحرام',
  'يلعن','عرص','شرموط','قحبة','زبالة','خنزير',
  'تبان','منيوك','زاني','فاسق','لقيط','عاهرة','ديوث'
];
const hasBadWord = (text) => BAD_WORDS.some(w => text.toLowerCase().includes(w));

// ===== Gemini الرسمي =====
async function askGemini(userId, userMessage) {
  const hist = getMemory(userId);

  // بناء تاريخ المحادثة
  const contents = [
    ...hist.slice(-6),
    { role: 'user', parts: [{ text: userMessage }] }
  ];

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      system_instruction: {
        parts: [{
          text: `اسمك ${BOT_NAME}. قواعدك:
- ردودك دائماً مختصرة (جملة أو جملتين فقط)
- بالعربية دائماً
- ودود ومحترم
- بدون نقاط أو قوائم إلا لو ضروري
- تتذكر سياق المحادثة`
        }]
      },
      contents,
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0.7,
      }
    },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    }
  );

  const reply = res.data.candidates[0].content.parts[0].text.trim();

  // حفظ المحادثة
  hist.push({ role: 'user', parts: [{ text: userMessage }] });
  hist.push({ role: 'model', parts: [{ text: reply }] });
  if (hist.length > 20) hist.splice(0, 2);

  return reply;
}

// ===================================================
//              🚀 تشغيل البوت
// ===================================================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  // ===== ربط برقم الهاتف =====
  if (!sock.authState.creds.registered) {
    if (!PHONE_NUMBER) {
      console.log('❌ حط PHONE_NUMBER في Environment Variables');
      process.exit(1);
    }
    const cleanNumber = PHONE_NUMBER.replace(/[^0-9]/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(cleanNumber);
        console.log(`\n✅ كود الربط: ${code}`);
        console.log('واتساب ← الأجهزة المرتبطة ← ربط جهاز ← ربط برقم الهاتف\n');
      } catch (err) {
        console.error('خطأ كود:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('❌ انقطع، جاري إعادة الاتصال...');
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} متصل وجاهز!`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const sender = msg.key.remoteJid;
      const isGroup = sender.endsWith('@g.us');
      const senderUser = msg.key.participant || msg.key.remoteJid;

      // تجاهل إذا مش رقمي (الخاص فقط + المجموعات)
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text || '';

      if (!text.trim()) continue;
      const body = text.trim();
      console.log(`📩 ${senderUser}: ${body}`);

      // ===== فلتر الكلام السيء =====
      if (isGroup && hasBadWord(body)) {
        try {
          await sock.sendMessage(sender, { delete: msg.key });
          await sock.sendMessage(sender, {
            text: `⚠️ تحذير @${senderUser.split('@')[0]} - الكلام السيء ممنوع!`,
            mentions: [senderUser]
          });
        } catch (e) { console.error('خطأ حذف:', e.message); }
        continue;
      }

      // ===== أوامر المجموعة =====
      if (isGroup && body.startsWith('!')) {
        try {
          const groupMeta = await sock.groupMetadata(sender);
          const isAdmin = groupMeta.participants.find(p => p.id === senderUser)?.admin != null;

          if (body.startsWith('!طرد')) {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) { await sock.sendMessage(sender, { text: '⚠️ !طرد @شخص' }); continue; }
            await sock.groupParticipantsUpdate(sender, mentioned, 'remove');
            await sock.sendMessage(sender, { text: '✅ تم الطرد' });
            continue;
          }

          if (body.startsWith('!كتم')) {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
            if (!mentioned.length) { await sock.sendMessage(sender, { text: '⚠️ !كتم @شخص' }); continue; }
            await sock.groupParticipantsUpdate(sender, mentioned, 'demote');
            await sock.sendMessage(sender, { text: '🔇 تم الكتم', mentions: mentioned });
            continue;
          }

          if (body === '!قفل') {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            await sock.groupSettingUpdate(sender, 'announcement');
            await sock.sendMessage(sender, { text: '🔒 المجموعة مقفلة' });
            continue;
          }

          if (body === '!فتح') {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            await sock.groupSettingUpdate(sender, 'not_announcement');
            await sock.sendMessage(sender, { text: '🔓 المجموعة مفتوحة' });
            continue;
          }

          if (body.startsWith('!منشن')) {
            if (!isAdmin) { await sock.sendMessage(sender, { text: '❌ للمشرفين فقط!' }); continue; }
            const members = groupMeta.participants.map(p => p.id);
            const mentionText = body.replace('!منشن', '').trim() || '📢 تنبيه!';
            await sock.sendMessage(sender, {
              text: `${mentionText}\n\n${members.map(m => `@${m.split('@')[0]}`).join(' ')}`,
              mentions: members
            });
            continue;
          }

          if (body === '!وقت') {
            const now = new Date().toLocaleString('ar-SY', { timeZone: 'Asia/Damascus', hour: '2-digit', minute: '2-digit', hour12: true });
            await sock.sendMessage(sender, { text: `🕐 ${now}` });
            continue;
          }

          if (body === '!تاريخ') {
            const today = new Date().toLocaleDateString('ar-SY', { timeZone: 'Asia/Damascus', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
            await sock.sendMessage(sender, { text: `📅 ${today}` });
            continue;
          }

          if (body === '!مساعدة') {
            await sock.sendMessage(sender, {
              text:
                `🤖 *${BOT_NAME}:*\n\n` +
                `!طرد @شخص\n!كتم @شخص\n!قفل\n!فتح\n` +
                `!منشن نص\n!وقت\n!تاريخ\n!مساعدة\n\n` +
                `أو اسألني أي شي 😊`
            });
            continue;
          }

        } catch (e) { console.error('خطأ أوامر:', e.message); }
        continue;
      }

      // ===== Gemini يرد على كل شي =====
      try {
        await sock.sendPresenceUpdate('composing', sender);
        const reply = await askGemini(senderUser, body);
        await sock.sendMessage(sender, { text: reply });
      } catch (e) {
        console.error('خطأ Gemini:', e.message);
        await sock.sendMessage(sender, { text: '⚠️ جرب مرة ثانية.' });
      }
    }
  });
}

startBot();
