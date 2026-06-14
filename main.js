const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIO = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Supabase setup
let supabase = null;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log('✅ Supabase connected');
  }
} catch (error) {
  console.log('⚠️ Supabase not configured');
}

// Auth folder
const AUTH_FOLDER = path.join(__dirname, 'auth_info_baileys');
if (!fs.existsSync(AUTH_FOLDER)) fs.mkdirSync(AUTH_FOLDER, { recursive: true });

let qrSent = false;

async function syncFromSupabase() {
  if (!supabase) return false;
  try {
    const { data, error } = await supabase.from('whatsapp_auth_files').select('filename, content');
    if (error) throw error;
    if (data && data.length > 0) {
      for (const file of data) {
        fs.writeFileSync(path.join(AUTH_FOLDER, file.filename), file.content);
      }
      console.log('✅ Auth restored from Supabase');
      return true;
    }
    return false;
  } catch (error) { return false; }
}

async function syncToSupabase() {
  if (!supabase) return;
  try {
    const files = fs.readdirSync(AUTH_FOLDER);
    for (const filename of files) {
      const content = fs.readFileSync(path.join(AUTH_FOLDER, filename), 'utf-8');
      await supabase.from('whatsapp_auth_files').upsert({ filename, content, updated_at: new Date().toISOString() }, { onConflict: 'filename' });
    }
  } catch (error) { console.error('Sync error:', error.message); }
}

async function clearAuthData() {
  console.log('🗑️ Clearing auth data...');
  if (sock) {
    try { await sock.logout(); sock.end(); } catch(e) {}
    sock = null;
  }
  if (fs.existsSync(AUTH_FOLDER)) {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    fs.mkdirSync(AUTH_FOLDER, { recursive: true });
  }
  if (supabase) await supabase.from('whatsapp_auth_files').delete().neq('id', 0);
  isClientReady = false;
  currentQR = null;
  reconnectAttempts = 0;
  qrSent = false;
}

// OpenRouter AI Client
class OpenRouterClient {
  constructor(model = "openrouter/free") {
    this.apiKey = process.env.API;
    this.url = "https://openrouter.ai/api/v1/chat/completions";
    this.model = model;
  }
  async chat(message, systemPrompt = null, conversationHistory = []) {
    if (!this.apiKey) return null;
    const messages = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    if (conversationHistory.length > 0) messages.push(...conversationHistory.slice(-6));
    messages.push({ role: "user", content: message });
    try {
      const response = await axios.post(this.url, {
        model: this.model, messages: messages, max_tokens: 500, temperature: 0.7
      }, { headers: { Authorization: `Bearer ${this.apiKey}` }, timeout: 30000 });
      return response.data?.choices?.[0]?.message?.content || null;
    } catch (error) { return null; }
  }
}

const conversationHistory = new Map();
const messageStore = new Map();

// College Data
const collegeData = {
  aboutCCAM: {
    mission: "To empower accountants with knowledge and skills to succeed as lifelong professionals in a global world.",
    vision: "To be a leader in empowering accountants to acquire, demonstrate and value knowledge with integrity, accountability and excellence.",
    coreValues: "Professionalism, Integrity, Excellence.",
    accreditation: "CCAM is accredited by ICPAU as an Approved Tuition Provider offering all CPA papers Levels 1–4.",
    whyChoose: [
      "Professional and student oriented lecturers",
      "Hybrid delivery that allows for real time class attendance",
      "Professional administrators that support your CPA journey",
      "Free practical sessions for e-Tax & EFRIS",
      "Rewards for best performers"
    ]
  },
  papersTaught: {
    level1: [{ code: "P.1", name: "FINANCIAL ACCOUNTING" }, { code: "P.2", name: "ECONOMICS AND ENTREPRENEURSHIP" }, { code: "P.3", name: "QUANTITATIVE TECHNIQUES" }, { code: "P.4", name: "BUSINESS MANAGEMENT & INFORMATION SYSTEMS" }, { code: "P.5", name: "BUSINESS & COMPANY LAW" }, { code: "P.6", name: "COST AND MANAGEMENT ACCOUNTING" }],
    level2: [{ code: "P.7", name: "FINANCIAL REPORTING" }, { code: "P.8", name: "FINANCIAL MANAGEMENT" }, { code: "P.9", name: "AUDITING, ETHICS & ASSURANCE" }, { code: "P.10", name: "MANAGEMENT DECISION & CONTROL" }, { code: "P.11", name: "TAXATION" }],
    level3: [{ code: "P.12", name: "ADVANCED FINANCIAL REPORTING" }, { code: "P.13", name: "PUBLIC FINANCIAL MANAGEMENT" }, { code: "P.14", name: "STRATEGY, GOVERNANCE & LEADERSHIP" }, { code: "P.15", name: "ADVANCED FINANCIAL MANAGEMENT" }, { code: "P.16", name: "AUDIT PRACTICE AND ASSURANCE" }, { code: "P.17", name: "ADVANCED TAXATION" }],
    level4: [{ code: "P.18", name: "Integration of Knowledge" }]
  },
  programs: { description: "Hybrid (online & Physical) for both evening and weekend.", evening: "6:00pm to 9:00pm", weekend: { saturday: "9:00am to 9:00pm", sunday: "9:00am to 5:00pm" } },
  registration: { onlineLink: "https://capitalcollege.ac.ug/student-registration-2/", physicalLocation: "At the office" },
  payments: { fees: { level1: 220000, level2: 250000, level3: 250000, level4: 300000 }, options: ["Cash at College", "DTB Bank A/C 0071144001", "MTN & Airtel Mobile Money via School Pay"] },
  revision: { contact: "0783933012 / 0757126551", method: "Contact admin or engage your tutor in the WhatsApp group" },
  ICPAU: { registrationFees: 150000, annualSubscription: 120000, paperCosts: { level1: { normal: 110000, late: 165000 }, level2: { normal: 120000, late: 180000 }, level3: { normal: 125000, late: 187500 }, level4: { normal: 330000, late: 495000 } } },
  contact: { phone: "0783933012 / 0757126551", website: "https://capitalcollege.ac.ug" }
};

const menuOptions = { "1": "About CCAM", "2": "Papers taught", "3": "Programs", "4": "Registration", "5": "Payments", "6": "Revision", "7": "ICPAU inquiry" };

function getMenuResponse(option) {
  switch(option) {
    case "1": return `📌 ABOUT CCAM\n\n🎯 MISSION:\n${collegeData.aboutCCAM.mission}\n\n👁️ VISION:\n${collegeData.aboutCCAM.vision}\n\n💎 CORE VALUES:\n${collegeData.aboutCCAM.coreValues}\n\n✅ ACCREDITATION:\n${collegeData.aboutCCAM.accreditation}\n\n⭐ WHY CHOOSE CCAM:\n${collegeData.aboutCCAM.whyChoose.map((item, i) => `${i+1}. ${item}`).join('\n')}`;
    case "2": return `📚 PAPERS TAUGHT\n\n${Object.entries(collegeData.papersTaught).map(([level, papers]) => `*${level.toUpperCase()}*\n${papers.map(p => `📖 ${p.code}: ${p.name}`).join('\n')}`).join('\n\n')}`;
    case "3": return `🕐 PROGRAMS\n\n${collegeData.programs.description}\n\n🌙 EVENING: ${collegeData.programs.evening}\n\n📅 WEEKEND:\nSaturday: ${collegeData.programs.weekend.saturday}\nSunday: ${collegeData.programs.weekend.sunday}`;
    case "4": return `📝 REGISTRATION\n\n🌐 Online: ${collegeData.registration.onlineLink}\n\n🏢 Physical: ${collegeData.registration.physicalLocation}`;
    case "5": return `💰 FEES PER PAPER\n\nLevel 1: UGX ${collegeData.payments.fees.level1.toLocaleString()}/=\nLevel 2: UGX ${collegeData.payments.fees.level2.toLocaleString()}/=\nLevel 3: UGX ${collegeData.payments.fees.level3.toLocaleString()}/=\nLevel 4: UGX ${collegeData.payments.fees.level4.toLocaleString()}/=\n\n💳 PAYMENT OPTIONS:\n${collegeData.payments.options.map(o => `• ${o}`).join('\n')}`;
    case "6": return `📚 REVISION\n\n📞 Contact: ${collegeData.revision.contact}\n\n${collegeData.revision.method}`;
    case "7": return `🏛️ ICPAU FEES\n\nRegistration: UGX ${collegeData.ICPAU.registrationFees.toLocaleString()}/= (paid once)\nAnnual Subscription: UGX ${collegeData.ICPAU.annualSubscription.toLocaleString()}/=\n\n📋 PAPER COSTS PER LEVEL:\nLevel 1: Normal ${collegeData.ICPAU.paperCosts.level1.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level1.late.toLocaleString()}/=\nLevel 2: Normal ${collegeData.ICPAU.paperCosts.level2.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level2.late.toLocaleString()}/=\nLevel 3: Normal ${collegeData.ICPAU.paperCosts.level3.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level3.late.toLocaleString()}/=\nLevel 4: Normal ${collegeData.ICPAU.paperCosts.level4.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level4.late.toLocaleString()}/=`;
    default: return null;
  }
}

function getAISystemPrompt() {
  return `You are a customer service assistant for Capital College. ONLY use this data: ${JSON.stringify(collegeData)}. If asked something not in this data, say "I don't have that information. Please contact admin at ${collegeData.contact.phone}"`;
}

async function getAIResponse(userMessage, history) {
  const ai = new OpenRouterClient();
  return await ai.chat(userMessage, getAISystemPrompt(), history.map(msg => ({ role: msg.role, content: msg.content })));
}

async function storeMessage(userId, message, response) {
  try {
    if (!messageStore.has(userId)) messageStore.set(userId, []);
    messageStore.get(userId).push({ message, response, timestamp: new Date().toISOString() });
    if (messageStore.get(userId).length > 50) messageStore.get(userId).shift();
    if (supabase) await supabase.from('whatsapp_messages').insert([{ user_id: userId, message, response, timestamp: new Date().toISOString() }]);
  } catch(e) {}
}

async function getLastMessages(userId, limit = 7) {
  const userMessages = messageStore.get(userId) || [];
  return userMessages.slice(-limit).map(msg => ({ role: 'user', content: msg.message }));
}

let sock = null, currentQR = null, isClientReady = false, reconnectAttempts = 0;

async function connectToWhatsApp() {
  try {
    console.log('🔄 Connecting to WhatsApp...');
    await syncFromSupabase();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    sock = makeWASocket({ 
      version, 
      auth: state, 
      printQRInTerminal: true, 
      logger: P({ level: 'silent' }), 
      browser: ['Capital College Bot', 'Chrome', '1.0.0'], 
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 10000
    });
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !qrSent) {
        currentQR = qr;
        qrSent = true;
        try { 
          const qrImage = await qrcode.toDataURL(qr, { scale: 8 });
          io.emit('qr', qrImage);
        } catch(err) { 
          io.emit('qr', qr);
        }
        reconnectAttempts = 0;
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Connection closed');
        qrSent = false;
        if (shouldReconnect && reconnectAttempts < 5) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          console.log(`🔄 Reconnecting in ${delay/1000}s... (Attempt ${reconnectAttempts})`);
          setTimeout(() => connectToWhatsApp(), delay);
        } else if (statusCode === DisconnectReason.loggedOut) {
          isClientReady = false;
          io.emit('disconnected', 'Logged out');
          qrSent = false;
        }
      } else if (connection === 'open') { 
        console.log('✅ WhatsApp connected!'); 
        isClientReady = true; 
        reconnectAttempts = 0;
        io.emit('ready', 'WhatsApp client is ready!'); 
      }
    });
    sock.ev.on('creds.update', async () => { await saveCreds(); await syncToSupabase(); });
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const sender = msg.key.remoteJid;
      const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!messageText) return;
      const userMessage = messageText.trim().toLowerCase();
      let response;
      if (userMessage === 'hi' || userMessage === 'hello' || userMessage === 'hey') {
        response = `🎓 Welcome to Capital College!\n\nSelect an option:\n1️⃣ About CCAM\n2️⃣ Papers taught\n3️⃣ Programs\n4️⃣ Registration\n5️⃣ Payments\n6️⃣ Revision\n7️⃣ ICPAU inquiry\n\nOr type your question. 🤝\n\n📞 Contact: ${collegeData.contact.phone}`;
      } else if (menuOptions[userMessage]) {
        response = getMenuResponse(userMessage);
      } else {
        const history = await getLastMessages(sender, 6);
        const aiResponse = await getAIResponse(messageText, history);
        response = aiResponse || `Please select an option:\n1️⃣ About CCAM\n2️⃣ Papers taught\n3️⃣ Programs\n4️⃣ Registration\n5️⃣ Payments\n6️⃣ Revision\n7️⃣ ICPAU inquiry`;
      }
      if (response) { 
        await sock.sendMessage(sender, { text: response }); 
        await storeMessage(sender, messageText, response); 
        io.emit('new_message', { from: sender, body: messageText, response, timestamp: new Date().toISOString() }); 
      }
    });
    sock.ev.on('error', (err) => {
      console.error('Socket error:', err.message);
    });
  } catch (error) { 
    console.error('❌ Connection error:', error.message); 
    setTimeout(() => connectToWhatsApp(), 10000); 
  }
}

// API Routes
app.get('/api/status', (req, res) => res.json({ ready: isClientReady, qrCode: currentQR }));
app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!isClientReady || !sock) return res.status(400).json({ error: 'WhatsApp not ready' });
  try { await sock.sendMessage(number.includes('@') ? number : `${number}@s.whatsapp.net`, { text: message }); res.json({ success: true }); } catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/logout', async (req, res) => { await clearAuthData(); io.emit('disconnected', 'Logged out'); res.json({ success: true }); });
app.post('/api/request-qr', async (req, res) => { qrSent = false; await clearAuthData(); setTimeout(() => connectToWhatsApp(), 1000); res.json({ success: true }); });

// Serve HTML page with Glass Effect
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Capital College WhatsApp Bot</title>
    <script src="/socket.io/socket.io.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            position: relative;
            overflow-x: hidden;
        }
        
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="20" cy="20" r="2" fill="rgba(255,255,255,0.1)"/><circle cx="80" cy="40" r="3" fill="rgba(255,255,255,0.1)"/><circle cx="50" cy="80" r="2" fill="rgba(255,255,255,0.1)"/></svg>');
            pointer-events: none;
        }
        
        .container {
            max-width: 550px;
            margin: 0 auto;
            backdrop-filter: blur(10px);
            background: rgba(255, 255, 255, 0.95);
            border-radius: 30px;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
            overflow: hidden;
            transition: transform 0.3s ease;
        }
        
        .container:hover {
            transform: translateY(-5px);
        }
        
        .header {
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            padding: 30px;
            text-align: center;
            position: relative;
            overflow: hidden;
        }
        
        .header::before {
            content: '';
            position: absolute;
            top: -50%;
            left: -50%;
            width: 200%;
            height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
            animation: shimmer 3s infinite;
        }
        
        @keyframes shimmer {
            0% { transform: translate(-30%, -30%); }
            100% { transform: translate(30%, 30%); }
        }
        
        .header h1 {
            font-size: 2em;
            margin-bottom: 5px;
            color: white;
            font-weight: 700;
            letter-spacing: -0.5px;
        }
        
        .header p {
            opacity: 0.9;
            font-size: 0.9em;
            color: rgba(255,255,255,0.9);
        }
        
        .qr-container {
            padding: 40px;
            text-align: center;
            background: linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%);
        }
        
        #qr-code {
            display: inline-block;
            background: white;
            padding: 20px;
            border-radius: 20px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.1);
            transition: all 0.3s ease;
        }
        
        #qr-code:hover {
            transform: scale(1.02);
            box-shadow: 0 15px 50px rgba(0,0,0,0.15);
        }
        
        #qr-code img {
            width: 200px;
            height: 200px;
            display: block;
            border-radius: 10px;
        }
        
        .status {
            text-align: center;
            padding: 12px 20px;
            margin: 20px;
            border-radius: 50px;
            font-weight: 600;
            font-size: 14px;
            backdrop-filter: blur(5px);
            transition: all 0.3s ease;
        }
        
        .status.connected {
            background: linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%);
            color: #1e3c72;
            border: 1px solid rgba(30,60,114,0.2);
        }
        
        .status.disconnected {
            background: linear-gradient(135deg, #fda4a4 0%, #fbc2c2 100%);
            color: #721c24;
            border: 1px solid rgba(114,28,36,0.2);
        }
        
        .status.scanning {
            background: linear-gradient(135deg, #ffeaa7 0%, #fdcb6e 100%);
            color: #d63031;
            border: 1px solid rgba(214,48,49,0.2);
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.8; }
        }
        
        .button-group {
            display: flex;
            gap: 15px;
            padding: 0 20px 20px 20px;
        }
        
        button {
            flex: 1;
            padding: 12px 20px;
            border: none;
            border-radius: 50px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            font-size: 14px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .btn-logout {
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
        }
        
        .btn-logout:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(245,87,108,0.4);
        }
        
        .btn-refresh {
            background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
            color: white;
        }
        
        .btn-refresh:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(79,172,254,0.4);
        }
        
        .message-area {
            padding: 0 20px 20px 20px;
            max-height: 350px;
            overflow-y: auto;
            background: rgba(248, 249, 250, 0.9);
            border-top: 1px solid rgba(0,0,0,0.05);
        }
        
        .message-area h4 {
            margin: 15px 0;
            color: #1e3c72;
            font-size: 14px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        .message-item {
            background: white;
            padding: 12px;
            margin: 10px 0;
            border-radius: 15px;
            border-left: 4px solid #2a5298;
            box-shadow: 0 2px 5px rgba(0,0,0,0.05);
            transition: all 0.3s ease;
        }
        
        .message-item:hover {
            transform: translateX(5px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        
        .message-from {
            font-weight: bold;
            color: #2a5298;
            margin-bottom: 8px;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .message-text {
            color: #333;
            margin-bottom: 8px;
            word-wrap: break-word;
            font-size: 13px;
        }
        
        .message-response {
            background: linear-gradient(135deg, #e3f2fd 0%, #bbdef5 100%);
            padding: 10px;
            border-radius: 12px;
            margin-top: 8px;
            color: #1e3c72;
            font-size: 12px;
            line-height: 1.5;
        }
        
        .message-time {
            font-size: 10px;
            color: #999;
            margin-top: 8px;
        }
        
        .no-messages {
            text-align: center;
            color: #999;
            padding: 30px;
            font-size: 13px;
        }
        
        .footer {
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            padding: 15px;
            text-align: center;
            font-size: 11px;
            color: rgba(255,255,255,0.7);
        }
        
        .footer a {
            color: #ffd700;
            text-decoration: none;
            font-weight: 600;
            transition: color 0.3s ease;
        }
        
        .footer a:hover {
            color: #fff;
            text-decoration: underline;
        }
        
        .brand {
            font-weight: bold;
            color: #ffd700;
        }
        
        .spinner {
            display: inline-block;
            width: 50px;
            height: 50px;
            border: 4px solid #f3f3f3;
            border-top: 4px solid #2a5298;
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .qr-placeholder {
            width: 200px;
            height: 200px;
            display: flex;
            align-items: center;
            justify-content: center;
            background: white;
            border-radius: 15px;
        }
        
        ::-webkit-scrollbar {
            width: 6px;
        }
        
        ::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 10px;
        }
        
        ::-webkit-scrollbar-thumb {
            background: linear-gradient(135deg, #1e3c72 0%, #2a5298 100%);
            border-radius: 10px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎓 Capital College</h1>
            <p>WhatsApp AI Assistant | 24/7 Support</p>
        </div>
        
        <div class="qr-container">
            <div id="qr-code">
                <div class="qr-placeholder">
                    <div class="spinner"></div>
                </div>
            </div>
            <div id="status" class="status disconnected">⚫ Disconnected</div>
        </div>
        
        <div class="button-group">
            <button class="btn-refresh" onclick="requestNewQR()">🔄 New QR Code</button>
            <button class="btn-logout" onclick="logout()">🔴 Disconnect</button>
        </div>
        
        <div class="message-area">
            <h4>📨 Recent Activity</h4>
            <div id="message-list">
                <div class="no-messages">No messages yet. Messages will appear here when users interact.</div>
            </div>
        </div>
        
        <div class="footer">
            Powered by <span class="brand">Capital College</span> | 
            Bot Managed by <a href="https://lunserktechnologies.com" target="_blank">Lunserk Technologies</a>
        </div>
    </div>
    
    <script>
        const socket = io();
        
        socket.on('qr', (qrData) => {
            const qrContainer = document.getElementById('qr-code');
            if (qrData && qrData.startsWith('data:image')) {
                qrContainer.innerHTML = \`<img src="\${qrData}" style="width: 200px; height: 200px;" alt="QR Code">\`;
            } else if (qrData) {
                qrContainer.innerHTML = \`<img src="\${qrData}" style="width: 200px; height: 200px;" alt="QR Code">\`;
            }
            const statusDiv = document.getElementById('status');
            statusDiv.className = 'status scanning';
            statusDiv.innerHTML = '📱 Scan QR Code with WhatsApp';
        });
        
        socket.on('ready', () => {
            const statusDiv = document.getElementById('status');
            statusDiv.className = 'status connected';
            statusDiv.innerHTML = '✅ Connected - Bot is ready to respond!';
            const qrContainer = document.getElementById('qr-code');
            qrContainer.innerHTML = '<div style="padding: 30px; text-align: center;">✅<br><span style="font-size: 12px;">Connected Successfully!</span></div>';
        });
        
        socket.on('disconnected', () => {
            const statusDiv = document.getElementById('status');
            statusDiv.className = 'status disconnected';
            statusDiv.innerHTML = '❌ Disconnected - Click New QR Code to reconnect';
            const qrContainer = document.getElementById('qr-code');
            qrContainer.innerHTML = '<div class="qr-placeholder"><div class="spinner"></div></div>';
        });
        
        socket.on('new_message', (data) => {
            addMessageToUI(data);
        });
        
        function addMessageToUI(data) {
            const messageList = document.getElementById('message-list');
            if (messageList.children.length === 1 && messageList.children[0].classList?.contains('no-messages')) {
                messageList.innerHTML = '';
            }
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message-item';
            const timestamp = new Date(data.timestamp).toLocaleTimeString();
            const fromDisplay = data.from.includes('@') ? data.from.split('@')[0] : data.from;
            const shortFrom = fromDisplay.length > 12 ? fromDisplay.slice(-12) : fromDisplay;
            messageDiv.innerHTML = \`
                <div class="message-from">📱 From: +\${escapeHtml(shortFrom)}</div>
                <div class="message-text"><strong>💬 Message:</strong> \${escapeHtml(data.body)}</div>
                <div class="message-response"><strong>🤖 Bot Response:</strong><br>\${escapeHtml(data.response).replace(/\\n/g, '<br>')}</div>
                <div class="message-time">🕐 \${timestamp}</div>
            \`;
            messageList.insertBefore(messageDiv, messageList.firstChild);
            while (messageList.children.length > 15) {
                messageList.removeChild(messageList.lastChild);
            }
        }
        
        function escapeHtml(text) {
            if (!text) return '';
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        async function requestNewQR() {
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = 'Requesting...';
            try {
                const response = await fetch('/api/request-qr', { method: 'POST' });
                const result = await response.json();
                if (result.success) {
                    const qrContainer = document.getElementById('qr-code');
                    qrContainer.innerHTML = '<div class="qr-placeholder"><div class="spinner"></div><div style="margin-top: 10px; font-size: 12px;">Generating new QR...</div></div>';
                    const statusDiv = document.getElementById('status');
                    statusDiv.className = 'status scanning';
                    statusDiv.innerHTML = '🔄 New QR requested - Please scan';
                } else {
                    alert('Failed to generate new QR');
                }
            } catch (error) { 
                alert('Error: ' + error.message); 
            }
            finally { 
                btn.disabled = false; 
                btn.textContent = '🔄 New QR Code'; 
            }
        }
        
        async function logout() {
            if (!confirm('⚠️ Are you sure you want to disconnect? The session will be cleared.')) return;
            const btn = event.target;
            btn.disabled = true;
            btn.textContent = 'Disconnecting...';
            try {
                await fetch('/api/logout', { method: 'POST' });
                const statusDiv = document.getElementById('status');
                statusDiv.className = 'status disconnected';
                statusDiv.innerHTML = '❌ Disconnected - Session cleared';
                const qrContainer = document.getElementById('qr-code');
                qrContainer.innerHTML = '<div class="qr-placeholder"><div class="spinner"></div></div>';
            } catch (error) { 
                alert('Error: ' + error.message); 
            }
            finally { 
                btn.disabled = false; 
                btn.textContent = '🔴 Disconnect'; 
            }
        }
        
        async function loadStatus() {
            try {
                const response = await fetch('/api/status');
                const status = await response.json();
                if (status.ready) {
                    const statusDiv = document.getElementById('status');
                    if (statusDiv.classList.contains('disconnected')) {
                        statusDiv.className = 'status connected';
                        statusDiv.innerHTML = '✅ Connected - Bot is ready to respond!';
                    }
                }
            } catch (error) { 
                console.error('Status error:', error); 
            }
        }
        
        setInterval(loadStatus, 10000);
    </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`💾 Auth: ${supabase ? 'Supabase' : 'Local'}`);
  console.log(`🤖 AI: ${process.env.API ? 'ENABLED' : 'DISABLED'}`);
  console.log(`📱 Bot starting...\n`);
});

connectToWhatsApp();