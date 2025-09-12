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

// --- AI response function ---
async function generateAIResponse(userMessage, dbContext) {
    const systemPrompt = `# Medical Scheduling Assistant System Prompt ... (same as before) ...\n\n## CURRENT DATABASE CONTEXT:\n${JSON.stringify(dbContext, null, 2)}`;

    const payload = {
        messages: [
            {
                role: 'user',
                content: JSON.stringify({
                    prompt: systemPrompt,
                    patient_message: userMessage
                })
            }
        ],
        inferenceConfig: {
            maxTokens: 1000,
            temperature: 0.7,
            topP: 0.9
        }
    };

    try {
        const response = await axios.post(
            `${BEDROCK_API_BASE}/model/us.amazon.nova-micro-v1:0/converse`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${BEARER_TOKEN}`
                },
                timeout: 60000
            }
        );

        const aiRaw = extractTextFromBedrockResponse(response);
        if (!aiRaw) {
            console.error('Unexpected Bedrock response:', Object.keys(response.data || {}));
            return generateFallbackResponse(userMessage, dbContext);
        }

        try {
            return JSON.parse(aiRaw);
        } catch {
            return { content: aiRaw, actions: [] };
        }
    } catch (error) {
        console.error('Error calling Bedrock:', (error.response && error.response.data) || error.message);
        return generateFallbackResponse(userMessage, dbContext);
    }
}

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