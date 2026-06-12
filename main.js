const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
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
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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

// Ensure auth folder exists
if (!fs.existsSync(AUTH_FOLDER)) {
  fs.mkdirSync(AUTH_FOLDER, { recursive: true });
}

// Function to sync files from Supabase to local
async function syncFromSupabase() {
  if (!supabase) return false;
  
  try {
    const { data, error } = await supabase
      .from('whatsapp_auth_files')
      .select('filename, content');
    
    if (error) throw error;
    
    if (data && data.length > 0) {
      for (const file of data) {
        const filePath = path.join(AUTH_FOLDER, file.filename);
        fs.writeFileSync(filePath, file.content);
        console.log(`📁 Restored: ${file.filename}`);
      }
      console.log('✅ Auth restored from Supabase');
      return true;
    }
    return false;
  } catch (error) {
    console.log('No existing auth in Supabase');
    return false;
  }
}

// Function to sync local files to Supabase
async function syncToSupabase() {
  if (!supabase) return;
  
  try {
    const files = fs.readdirSync(AUTH_FOLDER);
    
    for (const filename of files) {
      const filePath = path.join(AUTH_FOLDER, filename);
      const content = fs.readFileSync(filePath, 'utf-8');
      
      // Upsert
      const { error } = await supabase
        .from('whatsapp_auth_files')
        .upsert({ filename, content, updated_at: new Date().toISOString() }, { onConflict: 'filename' });
      
      if (error) throw error;
    }
    
    console.log('✅ Auth synced to Supabase');
  } catch (error) {
    console.error('Sync error:', error.message);
  }
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

        const payload = {
            model: this.model,
            messages: messages,
            stream: false,
            max_tokens: 500,
            temperature: 0.7
        };

        try {
            const response = await axios.post(this.url, payload, {
                headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
                timeout: 30000
            });
            
            const result = response.data;
            if (result.error) return null;
            if (result.choices && result.choices.length > 0) {
                return result.choices[0].message.content;
            }
            return null;
        } catch (error) {
            console.error("AI Error:", error.message);
            return null;
        }
    }
}

// Storage
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
      "Hybrid delivery that allows for real time class attendance for both physical and online students",
      "Professional administrators that exquisitely support your CPA journey",
      "Free practical sessions for e-Tax & EFRIS",
      "Rewards for best performers"
    ]
  },
  papersTaught: {
    level1: [
      { code: "P.1", name: "FINANCIAL ACCOUNTING" },
      { code: "P.2", name: "ECONOMICS AND ENTREPRENEURSHIP" },
      { code: "P.3", name: "QUANTITATIVE TECHNIQUES" },
      { code: "P.4", name: "BUSINESS MANAGEMENT & INFORMATION SYSTEMS" },
      { code: "P.5", name: "BUSINESS & COMPANY LAW" },
      { code: "P.6", name: "COST AND MANAGEMENT ACCOUNTING" }
    ],
    level2: [
      { code: "P.7", name: "FINANCIAL REPORTING" },
      { code: "P.8", name: "FINANCIAL MANAGEMENT" },
      { code: "P.9", name: "AUDITING, ETHICS & ASSURANCE" },
      { code: "P.10", name: "MANAGEMENT DECISION & CONTROL" },
      { code: "P.11", name: "TAXATION" }
    ],
    level3: [
      { code: "P.12", name: "ADVANCED FINANCIAL REPORTING" },
      { code: "P.13", name: "PUBLIC FINANCIAL MANAGEMENT" },
      { code: "P.14", name: "STRATEGY, GOVERNANCE & LEADERSHIP" },
      { code: "P.15", name: "ADVANCED FINANCIAL MANAGEMENT" },
      { code: "P.16", name: "AUDIT PRACTICE AND ASSURANCE" },
      { code: "P.17", name: "ADVANCED TAXATION" }
    ],
    level4: [
      { code: "P.18", name: "Integration of Knowledge" }
    ]
  },
  programs: {
    description: "Classes are Hybrid (online & Physical) for both evening and weekend.",
    evening: "6:00pm to 9:00pm",
    weekend: {
      saturday: "9:00am to 9:00pm",
      sunday: "9:00am to 5:00pm"
    }
  },
  registration: {
    onlineLink: "https://capitalcollege.ac.ug/student-registration-2/",
    physicalLocation: "At the office"
  },
  payments: {
    fees: {
      level1: 220000,
      level2: 250000,
      level3: 250000,
      level4: 300000
    },
    options: [
      "Cash at College",
      "DTB Bank A/C 0071144001",
      "MTN & Airtel Mobile Money via School Pay"
    ]
  },
  revision: {
    contact: "0783933012 / 0757126551",
    method: "Contact admin or engage your tutor in the respective WhatsApp group"
  },
  ICPAU: {
    registrationFees: 150000,
    annualSubscription: 120000,
    paperCosts: {
      level1: { normal: 110000, late: 165000 },
      level2: { normal: 120000, late: 180000 },
      level3: { normal: 125000, late: 187500 },
      level4: { normal: 330000, late: 495000 }
    }
  },
  contact: {
    phone: "0783933012 / 0757126551",
    website: "https://capitalcollege.ac.ug"
  }
};

const menuOptions = {
  "1": "About CCAM",
  "2": "Papers taught",
  "3": "Programs",
  "4": "Registration",
  "5": "Payments",
  "6": "Revision",
  "7": "Class modulation",
  "8": "FAQs",
  "9": "ICPAU inquiry"
};

function getMenuResponse(option) {
  switch(option) {
    case "1":
      return `*ABOUT CCAM*\n\n*MISSION:*\n${collegeData.aboutCCAM.mission}\n\n*VISION:*\n${collegeData.aboutCCAM.vision}\n\n*CORE VALUES:*\n${collegeData.aboutCCAM.coreValues}\n\n*ACCREDITATION:*\n${collegeData.aboutCCAM.accreditation}\n\n*WHY CHOOSE CCAM:*\n${collegeData.aboutCCAM.whyChoose.map((item, i) => `${i+1}. ${item}`).join('\n')}`;
    case "2":
      let papersResponse = "*📚 PAPERS TAUGHT*\n\n";
      papersResponse += "*LEVEL ONE*\n";
      collegeData.papersTaught.level1.forEach(p => { papersResponse += `📖 ${p.code}: ${p.name}\n`; });
      papersResponse += "\n*LEVEL TWO*\n";
      collegeData.papersTaught.level2.forEach(p => { papersResponse += `📖 ${p.code}: ${p.name}\n`; });
      papersResponse += "\n*LEVEL THREE*\n";
      collegeData.papersTaught.level3.forEach(p => { papersResponse += `📖 ${p.code}: ${p.name}\n`; });
      papersResponse += "\n*LEVEL FOUR*\n";
      collegeData.papersTaught.level4.forEach(p => { papersResponse += `📖 ${p.code}: ${p.name}\n`; });
      return papersResponse;
    case "3":
      return `*🕐 PROGRAMS*\n\n${collegeData.programs.description}\n\n*EVENING:* ${collegeData.programs.evening}\n\n*WEEKEND:*\nSaturday: ${collegeData.programs.weekend.saturday}\nSunday: ${collegeData.programs.weekend.sunday}`;
    case "4":
      return `*📝 REGISTRATION*\n\nOnline: ${collegeData.registration.onlineLink}\n\nPhysical: ${collegeData.registration.physicalLocation}`;
    case "5":
      let paymentResponse = "*💰 FEES PER PAPER:*\n";
      paymentResponse += `Level 1: UGX ${collegeData.payments.fees.level1.toLocaleString()}/=\n`;
      paymentResponse += `Level 2: UGX ${collegeData.payments.fees.level2.toLocaleString()}/=\n`;
      paymentResponse += `Level 3: UGX ${collegeData.payments.fees.level3.toLocaleString()}/=\n`;
      paymentResponse += `Level 4: UGX ${collegeData.payments.fees.level4.toLocaleString()}/=\n\n`;
      paymentResponse += "*PAYMENT OPTIONS:*\n";
      collegeData.payments.options.forEach(opt => { paymentResponse += `• ${opt}\n`; });
      return paymentResponse;
    case "6":
      return `*📚 REVISION*\n\nContact: ${collegeData.revision.contact}\n\n${collegeData.revision.method}`;
    case "7":
      return `*🎓 CLASS MODULATION*\n\n${collegeData.programs.description}\n\n*EVENING:* ${collegeData.programs.evening}\n*WEEKEND:* Saturday ${collegeData.programs.weekend.saturday}, Sunday ${collegeData.programs.weekend.sunday}`;
    case "8":
      return `*❓ FAQs*\n\nContact admin: ${collegeData.contact.phone}\nWebsite: ${collegeData.contact.website}`;
    case "9":
      let icpauResponse = "*🏛️ ICPAU FEES*\n\n";
      icpauResponse += `Registration: UGX ${collegeData.ICPAU.registrationFees.toLocaleString()}/= (paid once)\n`;
      icpauResponse += `Annual Subscription: UGX ${collegeData.ICPAU.annualSubscription.toLocaleString()}/=\n\n`;
      icpauResponse += "*PAPER COSTS PER LEVEL:*\n";
      icpauResponse += `Level 1: Normal ${collegeData.ICPAU.paperCosts.level1.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level1.late.toLocaleString()}/=\n`;
      icpauResponse += `Level 2: Normal ${collegeData.ICPAU.paperCosts.level2.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level2.late.toLocaleString()}/=\n`;
      icpauResponse += `Level 3: Normal ${collegeData.ICPAU.paperCosts.level3.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level3.late.toLocaleString()}/=\n`;
      icpauResponse += `Level 4: Normal ${collegeData.ICPAU.paperCosts.level4.normal.toLocaleString()}/= | Late ${collegeData.ICPAU.paperCosts.level4.late.toLocaleString()}/=`;
      return icpauResponse;
    default:
      return null;
  }
}

function getAISystemPrompt() {
  return `You are a customer service assistant for Capital College of Accountancy and Management (CCAM). 
  
IMPORTANT: ONLY use this data: ${JSON.stringify(collegeData)}. 
If asked something not in this data, say "I don't have that information. Please contact admin at ${collegeData.contact.phone}"
Keep responses friendly and helpful.`;
}

async function getAIResponse(userMessage, history) {
  const ai = new OpenRouterClient();
  const formattedHistory = history.map(msg => ({ role: msg.role, content: msg.content }));
  return await ai.chat(userMessage, getAISystemPrompt(), formattedHistory);
}

async function storeMessage(userId, message, response, type = 'incoming') {
  try {
    if (!messageStore.has(userId)) messageStore.set(userId, []);
    messageStore.get(userId).push({ message, response, type, timestamp: new Date().toISOString() });
    if (messageStore.get(userId).length > 50) messageStore.get(userId).shift();
    
    if (supabase) {
      await supabase.from('whatsapp_messages').insert([{ user_id: userId, message, response, message_type: type, timestamp: new Date().toISOString() }]);
    }
  } catch(e) {}
}

async function getLastMessages(userId, limit = 7) {
  try {
    const userMessages = messageStore.get(userId) || [];
    return userMessages.slice(-limit).map(msg => ({
      role: msg.type === 'incoming' ? 'user' : 'assistant',
      content: msg.type === 'incoming' ? msg.message : msg.response
    }));
  } catch(e) { return []; }
}

let sock = null;
let currentQR = null;
let isClientReady = false;
let reconnectAttempts = 0;

async function connectToWhatsApp() {
  try {
    console.log('🔄 Connecting to WhatsApp...');
    
    // Restore auth from Supabase
    await syncFromSupabase();
    
    // Use the built-in auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version: version,
      auth: state,
      printQRInTerminal: true,
      logger: P({ level: 'silent' }),
      browser: ['Capital College Bot', 'Chrome', '1.0.0'],
      connectTimeoutMs: 60000,
    });
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('📱 QR Code generated - Scan with WhatsApp');
        currentQR = qr;
        
        try {
          const qrImage = await qrcode.toDataURL(qr, { scale: 8 });
          io.emit('qr', qrImage);
        } catch (err) {
          io.emit('qr', qr);
        }
        reconnectAttempts = 0;
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('❌ Connection closed');
        
        if (shouldReconnect) {
          reconnectAttempts++;
          const delay = Math.min(5000 * reconnectAttempts, 30000);
          console.log(`🔄 Reconnecting in ${delay/1000}s...`);
          setTimeout(() => connectToWhatsApp(), delay);
        } else {
          isClientReady = false;
          io.emit('disconnected', 'Logged out');
          
          // Clear auth folder on logout
          if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            fs.mkdirSync(AUTH_FOLDER, { recursive: true });
          }
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected successfully!');
        isClientReady = true;
        io.emit('ready', 'WhatsApp client is ready!');
      }
    });
    
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await syncToSupabase();
      console.log('💾 Credentials saved to Supabase');
    });
    
    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages[0];
      if (!msg.message || msg.key.fromMe) return;
      
      const sender = msg.key.remoteJid;
      const messageText = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!messageText) return;
      
      console.log(`💬 Message: ${messageText.substring(0, 50)}`);
      const userMessage = messageText.trim();
      const userMessageLower = userMessage.toLowerCase();
      const userId = sender;
      
      let response;
      
      if (userMessageLower === 'hi' || userMessageLower === 'hello' || userMessageLower === 'hey') {
        response = `*🎓 Welcome to Capital College!*\n\nSelect an option:\n\n1️⃣ About CCAM\n2️⃣ Papers taught\n3️⃣ Programs\n4️⃣ Registration\n5️⃣ Payments\n6️⃣ Revision\n7️⃣ Class modulation\n8️⃣ FAQs\n9️⃣ ICPAU inquiry\n\nOr type your question. 🤝\n\n📞 Contact: ${collegeData.contact.phone}`;
      } 
      else if (menuOptions[userMessageLower]) {
        response = getMenuResponse(userMessageLower);
      } 
      else {
        const history = await getLastMessages(userId, 6);
        const aiResponse = await getAIResponse(userMessage, history);
        response = aiResponse || `Please type a number from the menu:\n\n1️⃣ About CCAM\n2️⃣ Papers taught\n3️⃣ Programs\n4️⃣ Registration\n5️⃣ Payments\n6️⃣ Revision\n7️⃣ Class modulation\n8️⃣ FAQs\n9️⃣ ICPAU inquiry`;
      }
      
      if (response) {
        await sock.sendMessage(sender, { text: response });
        await storeMessage(userId, userMessage, response);
        io.emit('new_message', { 
          from: sender, 
          body: userMessage, 
          response: response, 
          timestamp: new Date().toISOString() 
        });
      }
    });
    
  } catch (error) {
    console.error('❌ Connection error:', error.message);
    setTimeout(() => connectToWhatsApp(), 10000);
  }
}

// API Routes
app.get('/api/status', (req, res) => {
  res.json({ ready: isClientReady, qrCode: currentQR });
});

app.post('/api/send', async (req, res) => {
  const { number, message } = req.body;
  if (!isClientReady || !sock) return res.status(400).json({ error: 'WhatsApp not ready' });
  
  try {
    let chatId = number.includes('@') ? number : `${number}@s.whatsapp.net`;
    await sock.sendMessage(chatId, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock.end();
      sock = null;
    }
    
    // Delete local auth folder
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }
    
    // Delete from Supabase
    if (supabase) {
      await supabase.from('whatsapp_auth_files').delete().neq('id', 0);
    }
    
    isClientReady = false;
    currentQR = null;
    messageStore.clear();
    conversationHistory.clear();
    
    io.emit('disconnected', 'Logged out');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/messages', async (req, res) => {
  if (supabase) {
    const { data } = await supabase.from('whatsapp_messages').select('*').order('timestamp', { ascending: false }).limit(50);
    res.json({ messages: data || [] });
  } else {
    const allMessages = [];
    for (const [userId, messages] of messageStore) {
      allMessages.push({ userId, messages: messages.slice(-10) });
    }
    res.json({ messages: allMessages });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Server: http://localhost:${PORT}`);
  console.log(`💾 Auth Storage: ${supabase ? 'Supabase (Persistent)' : 'Local (Temporary)'}`);
  console.log(`🤖 AI Assistant: ${process.env.API ? 'ENABLED' : 'DISABLED'}`);
  console.log(`📱 WhatsApp Bot starting...\n`);
});

connectToWhatsApp();