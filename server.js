const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
require('dotenv').config();

const app = express();
// ⚡ Changed default port to 3000 (running on 80 requires sudo/root)
const PORT = process.env.PORT || 80;

// --- Bearer token configuration ---
const BEDROCK_API_BASE = process.env.BEDROCK_API_BASE || 'https://bedrock-runtime.us-east-1.amazonaws.com';
const BEARER_TOKEN = process.env.AWS_BEARER_TOKEN_BEDROCK;

if (!BEARER_TOKEN) {
    console.error('❌ AWS_BEARER_TOKEN_BEDROCK is required in environment variables');
    process.exit(1);
}

// --- Database connection ---
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Error connecting to database:', err);
    } else {
        console.log('✅ Connected to PostgreSQL database');
        release();
    }
});

// --- Express config ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Routes ---
app.get('/', (req, res) => {
    res.render('index', {
        title: 'HealthCare Scheduler',
        subtitle: 'AI-Powered Appointment Booking'
    });
});

// --- API endpoint for chat ---
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;

    try {
        const dbContext = await getDatabaseContext();
        const botResponse = await generateAIResponse(message, dbContext);

        res.json({ success: true, response: botResponse });
    } catch (error) {
        console.error('Error processing chat message:', error);
        res.status(500).json({ success: false, error: 'Sorry, I encountered an error processing your request.' });
    }
});

// --- Defensive Bedrock response extractor ---
function extractTextFromBedrockResponse(resp) {
    try {
        const out = resp.data;
        if (!out) return null;
        if (out.output?.message?.content && Array.isArray(out.output.message.content)) {
            const content = out.output.message.content[0];
            if (content?.text) return content.text;
            if (content?.parts && Array.isArray(content.parts) && content.parts[0]) return content.parts[0];
        }
        if (out.choices && Array.isArray(out.choices) && out.choices[0]?.message?.content) {
            return out.choices[0].message.content;
        }
        return typeof out === 'string' ? out : JSON.stringify(out).slice(0, 400);
    } catch {
        return null;
    }
}
// Add this function before generateAIResponse
function extractTextFromBedrockResponse(response) {
    try {
        return response.data.output.message.content[0].text;
    } catch (error) {
        console.error('Error extracting text from Bedrock response:', error);
        return null;
    }
}
// --- AI response function ---
// Replace your generateAIResponse function with this smart interpreter approach
async function generateAIResponse(userMessage, dbContext) {
    console.log('🔍 generateAIResponse called with:', userMessage);
    
    try {
        console.log('📋 Building system prompt...');
        const systemPrompt = `# Medical Appointment Interpreter

## ROLE
You are an intelligent interpreter for a medical appointment system. Your job is to:
1. Understand what the patient wants
2. Extract structured data for database queries
3. Provide clear, focused responses with specific options

## CORE FUNCTIONS

### INITIAL GREETING
- Ask how you can help with appointments
- If user wants non-scheduling help, politely redirect to scheduling only

### DOCTOR NAME INTERPRETATION  
When user mentions a doctor name:
- Match against available doctors: ${dbContext.doctors.map(d => `${d.name} (${d.specialty})`).join(', ')}
- If partial match found, confirm full name and specialty
- Provide available dates as selectable options

## RESPONSE FORMAT
Always return JSON:
{
  "content": "Your response text",
  "actions": [
    {"type": "select_doctor", "text": "Dr. Johnson (Cardiology)", "data": "doctor_id"}
  ]
}

## CURRENT DATA
Doctors: ${JSON.stringify(dbContext.doctors, null, 2)}

Keep responses short and focused. If user asks about non-medical topics, politely redirect to appointment scheduling only.`;

        console.log('📦 Building payload...');
        const payload = {
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            text: `${systemPrompt}\n\nUser says: "${userMessage}"\n\nProvide a helpful response.`
                        }
                    ]
                }
            ],
            inferenceConfig: {
                maxTokens: 800,
                temperature: 0.3,
                topP: 0.9
            }
        };

        console.log('🚀 Making Bedrock API call...');
        const response = await axios.post(
            `${BEDROCK_API_BASE}/model/us.amazon.nova-micro-v1:0/converse`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${BEARER_TOKEN}`
                },
                timeout: 30000
            }
        );

        console.log('✅ Bedrock API response received, status:', response.status);
        const aiRaw = extractTextFromBedrockResponse(response);
        console.log('📝 AI raw response:', aiRaw ? aiRaw.substring(0, 100) + '...' : 'NULL');

        if (!aiRaw) {
            console.log('⚠️ No AI response, using fallback');
            return generateSmartFallback(userMessage, dbContext);
        }

        try {
            const parsed = JSON.parse(aiRaw);
            console.log('✅ Successfully parsed AI JSON response');
            return parsed;
        } catch (parseError) {
            console.log('⚠️ AI response not JSON, using fallback. Raw response:', aiRaw);
            return generateSmartFallback(userMessage, dbContext, aiRaw);
        }
    } catch (error) {
        console.log('❌ Function failed at some point:', error.message);
        console.log('❌ Stack trace:', error.stack);
        return generateSmartFallback(userMessage, dbContext);
    }
}

// Smart fallback that interprets user intent without AI
function generateSmartFallback(userMessage, dbContext, aiText = null) {
    const input = userMessage.toLowerCase();
    
    // Check for doctor names
    const mentionedDoctor = dbContext.doctors.find(doc => 
        input.includes(doc.name.toLowerCase()) || 
        doc.name.toLowerCase().includes(input.replace(/dr\.?\s*/i, ''))
    );
    
    if (mentionedDoctor) {
        // Find available times for this doctor
        const availableTimes = dbContext.upcoming_availability
            .filter(slot => slot.doctor_id === mentionedDoctor.id)
            .slice(0, 5)
            .map(slot => ({
                type: 'select_date',
                text: `${formatDate(slot.available_date)} at ${formatTime(slot.start_time)}`,
                data: `${slot.doctor_id},${slot.available_date},${slot.start_time}`
            }));
            
        return {
            content: `Great! I found Dr. ${mentionedDoctor.name} in ${mentionedDoctor.specialty}. Here are available appointment times:`,
            actions: availableTimes
        };
    }
    
    // Check for specialties
    const specialties = [...new Set(dbContext.doctors.map(d => d.specialty.toLowerCase()))];
    const mentionedSpecialty = specialties.find(spec => input.includes(spec));
    
    if (mentionedSpecialty) {
        const specialtyDoctors = dbContext.doctors
            .filter(doc => doc.specialty.toLowerCase() === mentionedSpecialty)
            .map(doc => ({
                type: 'select_doctor',
                text: `Dr. ${doc.name}`,
                data: doc.id.toString()
            }));
            
        return {
            content: `Our ${mentionedSpecialty} specialists are:`,
            actions: specialtyDoctors
        };
    }
    
    // Default appointment scheduling response
    if (input.includes('appointment') || input.includes('schedule') || input.includes('book')) {
        const doctorActions = dbContext.doctors.slice(0, 6).map(doc => ({
            type: 'select_doctor',
            text: `Dr. ${doc.name} (${doc.specialty})`,
            data: doc.id.toString()
        }));
        
        return {
            content: "I'd be happy to help you schedule an appointment! Which doctor would you like to see?",
            actions: doctorActions
        };
    }
    
    // Greeting or general help
    return {
        content: "Hi! I'm here to help you schedule medical appointments. You can tell me:\n• A doctor's name you'd like to see\n• A medical specialty you need\n• That you'd like to schedule an appointment\n\nHow can I help you today?",
        actions: []
    };
}

// Add these helper functions for better date/time formatting
function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
    
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatTime(timeStr) {
    const [hours, minutes] = timeStr.split(':');
    const hour12 = hours > 12 ? hours - 12 : hours;
    const ampm = hours >= 12 ? 'PM' : 'AM';
    return `${hour12}:${minutes} ${ampm}`;
}

// Add handler for when user selects a doctor (add this as a new endpoint)
app.post('/api/select-doctor', async (req, res) => {
    const { doctorId } = req.body;
    
    try {
        const dbContext = await getDatabaseContext();
        const doctor = dbContext.doctors.find(d => d.id == doctorId);
        
        if (!doctor) {
            return res.status(404).json({ success: false, message: 'Doctor not found' });
        }
        
        const availableTimes = dbContext.upcoming_availability
            .filter(slot => slot.doctor_id == doctorId)
            .slice(0, 8)
            .map(slot => ({
                type: 'select_date',
                text: `${formatDate(slot.available_date)} at ${formatTime(slot.start_time)}`,
                data: `${slot.doctor_id},${slot.available_date},${slot.start_time}`
            }));
            
        res.json({
            success: true,
            response: {
                content: `Perfect! Dr. ${doctor.name} (${doctor.specialty}) has these available appointments:`,
                actions: availableTimes
            }
        });
        
    } catch (error) {
        console.error('Error selecting doctor:', error);
        res.status(500).json({ success: false, message: 'Error retrieving doctor availability' });
    }
});

// Add handler for when user selects a date/time
app.post('/api/select-appointment', async (req, res) => {
    const { appointmentData } = req.body; // Format: "doctorId,date,time"
    const [doctorId, date, time] = appointmentData.split(',');
    
    try {
        const dbContext = await getDatabaseContext();
        const doctor = dbContext.doctors.find(d => d.id == doctorId);
        
        // Check if still available
        const availability = await checkTimeSlotAvailability(doctorId, date, time);
        if (!availability.available) {
            return res.json({
                success: false,
                message: 'Sorry, that appointment time is no longer available.',
                response: {
                    content: 'That time slot was just taken. Let me show you other available times.',
                    actions: [] // Could populate with alternatives
                }
            });
        }
        
        res.json({
            success: true,
            response: {
                content: `Great choice! You've selected:\n\n📅 ${formatDate(date)} at ${formatTime(time)}\n👩‍⚕️ Dr. ${doctor.name} (${doctor.specialty})\n\nPlease provide your contact information to complete the booking:`,
                actions: [{
                    type: 'collect_info',
                    text: 'Continue to Book',
                    data: appointmentData
                }]
            }
        });
        
    } catch (error) {
        console.error('Error selecting appointment:', error);
        res.status(500).json({ success: false, message: 'Error processing appointment selection' });
    }
});

// --- Fallback response ---
function generateFallbackResponse(userInput, dbContext) {
    const input = userInput.toLowerCase();
    if (input.includes('appointment') || input.includes('schedule') || input.includes('book')) {
        const actions = dbContext.doctors.slice(0, 4).map(doc => ({
            type: 'button',
            text: `${doc.name} (${doc.specialty})`,
            action: 'select_doctor',
            data: doc.id.toString()
        }));
        return { content: 'I\'d be happy to help you schedule an appointment! Which doctor would you like to see?', actions };
    }
    return {
        content: "I'm here to help you schedule medical appointments. What would you like to do?",
        actions: []
    };
}

// --- Database context with FIXED availabilityQuery ---
async function getDatabaseContext() {
    try {
        const doctorsResult = await pool.query(`
            SELECT id, name, specialty, office_location
            FROM doctors
            WHERE is_active = true
            ORDER BY name;
        `);

        const availabilityQuery = `
          SELECT
            d.id AS doctor_id,
            d.name AS doctor_name,
            d.specialty,
            (CURRENT_DATE + (g.n || ' days')::interval)::date AS available_date,
            da.start_time,
            da.end_time
          FROM generate_series(0, 6) AS g(n)
          JOIN doctor_availability da
            ON da.day_of_week = EXTRACT(DOW FROM (CURRENT_DATE + (g.n || ' days')::interval))
          JOIN doctors d
            ON d.id = da.doctor_id
          WHERE d.is_active = true
            AND da.is_active = true
          ORDER BY available_date, da.start_time
          LIMIT 100;
        `;
        const availabilityResult = await pool.query(availabilityQuery);

        const appointmentsResult = await pool.query(`
            SELECT a.appointment_date, a.appointment_time, d.name as doctor_name, u.name as patient_name
            FROM appointments a
            JOIN doctors d ON a.doctor_id = d.id
            JOIN users u ON a.user_id = u.id
            WHERE a.appointment_date >= CURRENT_DATE
              AND a.appointment_date <= CURRENT_DATE + INTERVAL '7 days'
              AND a.status IN ('scheduled', 'confirmed')
            ORDER BY a.appointment_date, a.appointment_time;
        `);

        return {
            doctors: doctorsResult.rows,
            upcoming_availability: availabilityResult.rows,
            existing_appointments: appointmentsResult.rows,
            current_date: new Date().toISOString().split('T')[0],
            tomorrow_date: new Date(Date.now() + 86400000).toISOString().split('T')[0]
        };
    } catch (error) {
        console.error('Error getting database context:', error);
        return { doctors: [], upcoming_availability: [], existing_appointments: [], current_date: new Date().toISOString().split('T')[0], tomorrow_date: new Date(Date.now() + 86400000).toISOString().split('T')[0] };
    }
}

// --- Booking endpoint ---
app.post('/api/book-appointment', async (req, res) => {
    const { patientName, email, phone, doctorId, appointmentTypeId, appointmentDate, appointmentTime, reasonForVisit } = req.body;

    if (!patientName || !email || !doctorId || !appointmentDate || !appointmentTime) {
        return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    try {
        const availability = await checkTimeSlotAvailability(doctorId, appointmentDate, appointmentTime);
        if (!availability.available) {
            return res.json({
                success: false,
                message: 'Sorry, that time slot is no longer available.',
                alternatives: await getSuggestedAlternatives(doctorId, appointmentDate)
            });
        }

        const userId = await findOrCreateUser(patientName, email, phone);
        const appointment = await bookAppointment({ userId, doctorId, appointmentTypeId, appointmentDate, appointmentTime, reasonForVisit });

        res.json({ success: true, message: 'Appointment booked successfully!', appointment });
    } catch (error) {
        console.error('Error booking appointment:', error);
        res.status(500).json({ success: false, message: 'Error booking appointment. Please try again.' });
    }
});

// --- DB helpers ---
async function checkTimeSlotAvailability(doctorId, date, time) {
    try {
        const query = `
          SELECT CASE WHEN COUNT(*) = 0 THEN true ELSE false END as available
          FROM (
            SELECT 1 FROM appointments
             WHERE doctor_id = $1 AND appointment_date = $2 AND appointment_time = $3 AND status IN ('scheduled', 'confirmed')
            UNION ALL
            SELECT 1 FROM blocked_slots
             WHERE doctor_id = $1 AND blocked_date = $2 AND $3::time BETWEEN start_time AND end_time
          ) conflicts;
        `;
        const result = await pool.query(query, [doctorId, date, time]);
        return { available: !!result.rows[0].available };
    } catch (err) {
        console.error('checkTimeSlotAvailability error:', err);
        return { available: false };
    }
}

async function findOrCreateUser(name, email, phone) {
    let result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) return result.rows[0].id;
    result = await pool.query('INSERT INTO users (name, email, phone) VALUES ($1, $2, $3) RETURNING id', [name, email, phone]);
    return result.rows[0].id;
}

async function bookAppointment({ userId, doctorId, appointmentTypeId, appointmentDate, appointmentTime, reasonForVisit }) {
    const query = `
      INSERT INTO appointments (user_id, doctor_id, appointment_type_id, appointment_date, appointment_time, reason_for_visit, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'scheduled') RETURNING id, confirmation_number;
    `;
    const result = await pool.query(query, [userId, doctorId, appointmentTypeId || 1, appointmentDate, appointmentTime, reasonForVisit]);
    return result.rows[0];
}

async function getSuggestedAlternatives(doctorId) {
    const query = `
      SELECT DISTINCT da.start_time, (CURRENT_DATE + (g.n || ' days')::interval)::date as available_date
      FROM generate_series(0, 6) AS g(n)
      JOIN doctor_availability da ON da.day_of_week = EXTRACT(DOW FROM (CURRENT_DATE + (g.n || ' days')::interval))
      WHERE da.doctor_id = $1 AND da.is_active = true
      ORDER BY available_date, da.start_time
      LIMIT 5;
    `;
    const result = await pool.query(query, [doctorId]);
    return result.rows;
}

// --- Start server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏥 Medical Scheduler running at http://0.0.0.0:${PORT}`);
    console.log('📅 Ready to schedule appointments with AI!');
    console.log('🤖 AWS Bedrock Bearer Token integration enabled');
    console.log(`🌐 Access externally at: http://YOUR-EC2-PUBLIC-IP:${PORT}`);
});