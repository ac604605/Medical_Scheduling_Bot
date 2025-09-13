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
// Replace your generateAIResponse function with this smart interpreter approach
async function generateAIResponse(userMessage, dbContext) {
    console.log('🔍 generateAIResponse called with:', userMessage);
    
    try {
        console.log('📋 Building system prompt...');
        const systemPrompt = `# Medical Appointment Interpreter
		## RESPONSE FORMAT - CRITICAL
		Always return JSON with this EXACT structure:
		{
		  "content": "Your response text",
		  "actions": [
			{"type": "select_doctor", "text": "Dr. Johnson (Cardiology)", "data": "doctor_id"},
			{"type": "select_date", "text": "Tomorrow 2:00 PM", "data": "doctor_id,date,time"}
		  ]
		}

		NEVER use "options" arrays. NEVER use "slot" fields. Each action must have exactly: type, text, and data.

		For select_date actions, the data field must be exactly: "doctorId,YYYY-MM-DD,HH:MM:SS"

		Example: {"type": "select_date", "text": "Tuesday 2:00 PM", "data": "1,2025-09-16,14:00:00"}

		## CURRENT DATA
		Doctors: ${JSON.stringify(dbContext.doctors, null, 2)}
		Available appointments: ${JSON.stringify(dbContext.upcoming_availability.slice(0, 10), null, 2)}

		When user wants Dr. Sarah Johnson, create buttons like:
		{"type": "select_date", "text": "Today 8:00 AM", "data": "1,2025-09-12,08:00:00"}
		{"type": "select_date", "text": "Tomorrow 1:00 PM", "data": "1,2025-09-13,13:00:00"}

		Use the EXACT data format shown above. Do NOT create nested objects or arrays.

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
			console.log('AI Actions:', JSON.stringify(parsed.actions, null, 2));
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

app.post('/api/select-appointment', async (req, res) => {
	console.log('Appointment selction received:', req.body);
	console.log('Raw appointmentData:', req.body.appointmentData);
	
    const { appointmentData } = req.body; // Format: "doctorId,date,time"
    const splitData = appointmentData.split(',');
	console.log('Split data;', splitData);
	
	const [doctorId, date, time] = splitData;
	console.log('Parsed - Doctor ID:', doctorId, 'Date:', date, 'Time:', time);
    
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
                    actions: []
                }
            });
        }
        
        res.json({
            success: true,
            response: {
                content: `Great choice! You've selected:\n\n📅 ${formatDate(date)} at ${formatTime(time)}\n👩‍⚕️ ${doctor.name} (${doctor.specialty})\n\nPlease provide your contact information to complete the booking:`,
                actions: [{
                    type: 'collect_info',
                    text: 'Continue to Book',
                    data: appointmentData // Fixed - use the same data
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
				(CURRENT_DATE + (g.n || ' days')::interval)::date::text AS available_date,
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
        // Convert date to proper format if needed
        let dateStr = date;
        if (date instanceof Date) {
            dateStr = date.toISOString().split('T')[0]; // Convert to YYYY-MM-DD format
        } else if (typeof date === 'string' && date.includes('GMT')) {
            // If it's a date string with timezone info, parse and format it
            dateStr = new Date(date).toISOString().split('T')[0];
        }
        
        console.log('🗓️ Checking availability for:', doctorId, dateStr, time);
        
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
        
        const result = await pool.query(query, [doctorId, dateStr, time]);
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
// Add these helper functions first
function formatDate(dateStr) {
    // Handle both date strings and date objects
    let date;
    if (typeof dateStr === 'string') {
        // If it's already a string like "2025-09-17", use it directly
        date = new Date(dateStr + 'T00:00:00');
    } else {
        // If it's a Date object, convert it
        date = new Date(dateStr);
    }
    
    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    // Ensure we're comparing just the date parts
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

// Handler for when user selects a doctor
app.post('/api/select-doctor', async (req, res) => {
    const { doctorId } = req.body;
    console.log('🏥 Doctor selected:', doctorId);
    
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
            
        console.log('📅 Found', availableTimes.length, 'available times');
            
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

// Add this new endpoint to handle the final booking step
app.post('/api/complete-booking', async (req, res) => {
    const { appointmentData } = req.body;
    console.log('📋 Complete booking called with:', appointmentData);
    
    const [doctorId, date, time] = appointmentData.split(',');
    console.log('📋 Parsed booking - Doctor:', doctorId, 'Date:', date, 'Time:', time);
    
    try {
        const dbContext = await getDatabaseContext();
        const doctor = dbContext.doctors.find(d => d.id == doctorId);
        console.log('📋 Found doctor:', doctor ? doctor.name : 'NOT FOUND');
        
        if (!doctor) {
            console.log('❌ Doctor not found for booking');
            return res.status(404).json({ success: false, message: 'Doctor not found' });
        }
        
        // Check availability one more time
        const availability = await checkTimeSlotAvailability(doctorId, date, time);
        if (!availability.available) {
            return res.json({
                success: false,
                message: 'Sorry, that appointment time is no longer available.'
            });
        }
        
        // Book the appointment for "John Smith" (portfolio demo)
        const demoPatient = {
            name: "John Smith",
            email: "john.smith@email.com", 
            phone: "(555) 123-4567"
        };
        
        const userId = await findOrCreateUser(demoPatient.name, demoPatient.email, demoPatient.phone);
        const appointment = await bookAppointment({
            userId,
            doctorId,
            appointmentTypeId: 1,
            appointmentDate: date,
            appointmentTime: time,
            reasonForVisit: "General consultation"
        });
        
        console.log('📋 Appointment created:', appointment);
        
        // Generate confirmation email content
        const emailContent = generateEmailConfirmation(appointment, doctor, date, time, demoPatient);
        
        // Generate calendar file URL
        const calendarUrl = `/api/calendar/${appointment.id}`;
        
        res.json({
            success: true,
            response: {
                content: "🎉 **Appointment Confirmed!**\n\nYour appointment has been successfully booked. Below is your confirmation email and calendar file:",
                actions: [
                    {
                        type: 'show_email',
                        text: '📧 View Email Confirmation', 
                        data: emailContent
                    },
                    {
                        type: 'download_calendar',
                        text: '📅 Add to Calendar',
                        data: calendarUrl
                    },
                    {
                        type: 'start_over',
                        text: '🔄 Book Another Appointment',
                        data: 'new_booking'
                    }
                ]
            }
        });
        
    } catch (error) {
        console.log('❌ Complete booking error:', error.message);
        console.log('❌ Stack trace:', error.stack);
        res.status(500).json({ 
            success: false, 
            message: 'Error completing your booking. Please try again.' 
        });
    }
});
// Replace your existing /api/admin/patients endpoint with this enhanced version:
app.get('/api/admin/patients', async (req, res) => {
    const { page = 1, limit = 20, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    try {
        let query = `
            SELECT u.*, 
                   COUNT(a.id) as total_appointments,
                   MAX(a.appointment_date) as last_appointment
            FROM users u
            LEFT JOIN appointments a ON u.id = a.user_id
        `;
        
        let params = [];
        if (search) {
            query += ` WHERE u.name ILIKE $1 OR u.email ILIKE $1`;
            params.push(`%${search}%`);
        }
        
        query += ` GROUP BY u.id ORDER BY u.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const patients = await pool.query(query, params);
        
        res.json({
            success: true,
            data: patients.rows
        });
    } catch (error) {
        console.error('Error fetching patients:', error);
        res.status(500).json({ success: false, message: 'Error fetching patients' });
    }
});
// Generate email confirmation content
function generateEmailConfirmation(appointment, doctor, date, time, patient) {
    const formattedDate = formatDate(date);
    const formattedTime = formatTime(time);
    
    return `
**APPOINTMENT CONFIRMATION**

Dear ${patient.name},

Your medical appointment has been confirmed with the following details:

**📅 Appointment Information:**
- **Doctor:** ${doctor.name}
- **Specialty:** ${doctor.specialty}  
- **Date:** ${formattedDate}
- **Time:** ${formattedTime}
- **Confirmation #:** ${appointment.confirmation_number || appointment.id}

**🏥 Location:**
HealthCare Medical Center
123 Medical Plaza Drive
Orange, VA 22960

**📞 Contact Information:**
- Main Line: (540) 555-CARE (2273)
- Direct Line: ${doctor.office_location || 'Extension 1234'}

**📋 Important Instructions:**
• Please arrive 15 minutes early for check-in
• Bring a valid photo ID and insurance card
• Bring a list of current medications
• Wear comfortable, loose-fitting clothing
• If you need to cancel or reschedule, please call at least 24 hours in advance

**💳 Payment & Insurance:**
We accept most major insurance plans. Please verify your coverage before your visit.

**🦠 Health & Safety:**
• Please wear a mask in all clinical areas
• If you're feeling unwell, please call to reschedule
• Complete health screening will be required upon arrival

Thank you for choosing HealthCare Medical Center. We look forward to seeing you!

**Questions?** Call us at (540) 555-CARE or email appointments@healthcare.com

---
*This is an automated confirmation. Please do not reply to this message.*
    `.trim();
}

// Generate calendar file endpoint  
app.get('/api/calendar/:appointmentId', async (req, res) => {
    const { appointmentId } = req.params;
    console.log('📅 Calendar request for appointment:', appointmentId);
    
    try {
        // Get appointment details from database
        const appointmentQuery = `
            SELECT a.*, d.name as doctor_name, d.specialty, u.name as patient_name
            FROM appointments a
            JOIN doctors d ON a.doctor_id = d.id  
            JOIN users u ON a.user_id = u.id
            WHERE a.id = $1
        `;
        
        console.log('📅 Running calendar query for ID:', appointmentId);
        const result = await pool.query(appointmentQuery, [appointmentId]);
        console.log('📅 Query result rows:', result.rows.length);
        
        if (result.rows.length === 0) {
            console.log('❌ Appointment not found in database');
            return res.status(404).json({ error: 'Appointment not found' });
        }
        
        const appt = result.rows[0];
        console.log('📅 Found appointment:', appt);
        
        // Generate ICS file content
        console.log('📅 Generating ICS content...');
        const icsContent = generateICSFile(appt);
        console.log('📅 ICS content generated, length:', icsContent.length);
        
        // Set headers for calendar file download
        res.setHeader('Content-Type', 'text/calendar');
        res.setHeader('Content-Disposition', `attachment; filename="appointment-${appointmentId}.ics"`);
        res.send(icsContent);
        
    } catch (error) {
        console.error('❌ Calendar generation error:', error.message);
        console.error('❌ Stack trace:', error.stack);
        res.status(500).json({ error: 'Error generating calendar file' });
    }
});

// Generate ICS (iCalendar) file content
function generateICSFile(appointment) {
    console.log('📅 Generating ICS for appointment:', appointment);
    
    try {
        // Fix the date parsing - appointment_date comes as a Date object from PostgreSQL
        const appointmentDate = new Date(appointment.appointment_date);
        const dateStr = appointmentDate.toISOString().split('T')[0]; // Get YYYY-MM-DD
        
        // Combine date and time properly
        const startDateTime = new Date(`${dateStr}T${appointment.appointment_time}`);
        console.log('📅 Start datetime:', startDateTime);
        
        const endDateTime = new Date(startDateTime.getTime() + 30 * 60000); // 30 minutes later
        console.log('📅 End datetime:', endDateTime);
        
        // Format dates for ICS (YYYYMMDDTHHMMSSZ format)
        const formatICSDate = (date) => {
            return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
        };
        
        const startICS = formatICSDate(startDateTime);
        const endICS = formatICSDate(endDateTime);
        const now = formatICSDate(new Date());
        
        console.log('📅 ICS formatted dates - Start:', startICS, 'End:', endICS);
        
        return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//HealthCare Medical Center//Appointment Scheduler//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:appointment-${appointment.id}@healthcare.com
DTSTART:${startICS}
DTEND:${endICS}
DTSTAMP:${now}
SUMMARY:Medical Appointment - Dr. ${appointment.doctor_name}
DESCRIPTION:Medical appointment with Dr. ${appointment.doctor_name} (${appointment.specialty})
LOCATION:HealthCare Medical Center, 123 Medical Plaza Drive, Orange, VA 22960
ORGANIZER:CN=HealthCare Medical Center:MAILTO:appointments@healthcare.com
ATTENDEE:CN=${appointment.patient_name}:MAILTO:john.smith@email.com
STATUS:CONFIRMED
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR`;
        
    } catch (error) {
        console.error('❌ ICS generation error:', error);
        throw error;
    }
}
// Add these admin routes to your existing server.js

// =========================
// ADMIN DASHBOARD ROUTES
// =========================

// Admin dashboard home page
app.get('/admin', (req, res) => {
    res.render('admin/dashboard', {
        title: 'Admin Dashboard',
        subtitle: 'Healthcare Management System'
    });
});

// =========================
// DOCTOR MANAGEMENT APIs
// =========================

// Get all doctors (with pagination)
app.get('/api/admin/doctors', async (req, res) => {
    const { page = 1, limit = 10, search = '' } = req.query;
    const offset = (page - 1) * limit;
    
    try {
        let query = `
            SELECT d.*, 
                   COUNT(a.id) as total_appointments,
                   COUNT(CASE WHEN a.appointment_date >= CURRENT_DATE THEN 1 END) as upcoming_appointments
            FROM doctors d
            LEFT JOIN appointments a ON d.id = a.doctor_id
        `;
        
        let params = [];
        if (search) {
            query += ` WHERE d.name ILIKE $1 OR d.specialty ILIKE $1`;
            params.push(`%${search}%`);
        }
        
        query += ` GROUP BY d.id ORDER BY d.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
        params.push(limit, offset);
        
        const doctors = await pool.query(query, params);
        
        // Get total count for pagination
        let countQuery = `SELECT COUNT(*) FROM doctors d`;
        let countParams = [];
        if (search) {
            countQuery += ` WHERE d.name ILIKE $1 OR d.specialty ILIKE $1`;
            countParams.push(`%${search}%`);
        }
        
        const total = await pool.query(countQuery, countParams);
        
        res.json({
            success: true,
            data: doctors.rows,
            pagination: {
                total: parseInt(total.rows[0].count),
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total.rows[0].count / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching doctors:', error);
        res.status(500).json({ success: false, message: 'Error fetching doctors' });
    }
});

// Create new doctor
app.post('/api/admin/doctors', async (req, res) => {
    const { name, specialty, office_location, email, phone } = req.body;
    
    // Input validation
    if (!name || !specialty) {
        return res.status(400).json({ 
            success: false, 
            message: 'Name and specialty are required' 
        });
    }
    
    try {
        const query = `
            INSERT INTO doctors (name, specialty, office_location, email, phone, is_active)
            VALUES ($1, $2, $3, $4, $5, true)
            RETURNING *
        `;
        
        const result = await pool.query(query, [name, specialty, office_location, email, phone]);
        
        res.json({
            success: true,
            message: 'Doctor created successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating doctor:', error);
        if (error.code === '23505') { // Unique constraint violation
            res.status(400).json({ success: false, message: 'Doctor with this email already exists' });
        } else {
            res.status(500).json({ success: false, message: 'Error creating doctor' });
        }
    }
});

// Update doctor
app.put('/api/admin/doctors/:id', async (req, res) => {
    const { id } = req.params;
    const { name, specialty, office_location, email, phone, is_active } = req.body;
    
    try {
        const query = `
            UPDATE doctors 
            SET name = $1, specialty = $2, office_location = $3, email = $4, phone = $5, is_active = $6
            WHERE id = $7
            RETURNING *
        `;
        
        const result = await pool.query(query, [name, specialty, office_location, email, phone, is_active, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Doctor not found' });
        }
        
        res.json({
            success: true,
            message: 'Doctor updated successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating doctor:', error);
        res.status(500).json({ success: false, message: 'Error updating doctor' });
    }
});
// Delete doctor (soft delete)
app.delete('/api/admin/doctors/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        // Check if doctor has future appointments
        const appointmentCheck = await pool.query(
            `SELECT COUNT(*) FROM appointments WHERE doctor_id = $1 AND appointment_date >= CURRENT_DATE AND status IN ('scheduled', 'confirmed')`,
            [id]
        );
        
        if (parseInt(appointmentCheck.rows[0].count) > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Cannot delete doctor with upcoming appointments' 
            });
        }
        
        // Soft delete (remove updated_at reference)
        const result = await pool.query(
            `UPDATE doctors SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Doctor not found' });
        }
        
        res.json({
            success: true,
            message: 'Doctor deactivated successfully'
        });
    } catch (error) {
        console.error('Error deleting doctor:', error);
        res.status(500).json({ success: false, message: 'Error deleting doctor' });
    }
});

// =========================
// APPOINTMENT MANAGEMENT APIs
// =========================

// Get all appointments with filters
app.get('/api/admin/appointments', async (req, res) => {
    const { 
        page = 1, 
        limit = 20, 
        status = '', 
        doctor_id = '', 
        date_from = '', 
        date_to = '',
        search = ''
    } = req.query;
    
    const offset = (page - 1) * limit;
    
    try {
        let query = `
            SELECT a.*, d.name as doctor_name, d.specialty, u.name as patient_name, u.email, u.phone
            FROM appointments a
            JOIN doctors d ON a.doctor_id = d.id
            JOIN users u ON a.user_id = u.id
            WHERE 1=1
        `;
        
        let params = [];
        let paramCount = 0;
        
        if (status) {
            query += ` AND a.status = $${++paramCount}`;
            params.push(status);
        }
        
        if (doctor_id) {
            query += ` AND a.doctor_id = $${++paramCount}`;
            params.push(doctor_id);
        }
        
        if (date_from) {
            query += ` AND a.appointment_date >= $${++paramCount}`;
            params.push(date_from);
        }
        
        if (date_to) {
            query += ` AND a.appointment_date <= $${++paramCount}`;
            params.push(date_to);
        }
        
        if (search) {
            query += ` AND (u.name ILIKE $${++paramCount} OR u.email ILIKE $${paramCount} OR d.name ILIKE $${paramCount})`;
            params.push(`%${search}%`);
        }
        
        query += ` ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`;
        params.push(limit, offset);
        
        const appointments = await pool.query(query, params);
        
        // Get total count
        let countQuery = `
            SELECT COUNT(*) FROM appointments a
            JOIN doctors d ON a.doctor_id = d.id
            JOIN users u ON a.user_id = u.id
            WHERE 1=1
        `;
        
        let countParams = [];
        paramCount = 0;
        
        if (status) {
            countQuery += ` AND a.status = $${++paramCount}`;
            countParams.push(status);
        }
        if (doctor_id) {
            countQuery += ` AND a.doctor_id = $${++paramCount}`;
            countParams.push(doctor_id);
        }
        if (date_from) {
            countQuery += ` AND a.appointment_date >= $${++paramCount}`;
            countParams.push(date_from);
        }
        if (date_to) {
            countQuery += ` AND a.appointment_date <= $${++paramCount}`;
            countParams.push(date_to);
        }
        if (search) {
            countQuery += ` AND (u.name ILIKE $${++paramCount} OR u.email ILIKE $${paramCount} OR d.name ILIKE $${paramCount})`;
            countParams.push(`%${search}%`);
        }
        
        const total = await pool.query(countQuery, countParams);
        
        res.json({
            success: true,
            data: appointments.rows,
            pagination: {
                total: parseInt(total.rows[0].count),
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(total.rows[0].count / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching appointments:', error);
        res.status(500).json({ success: false, message: 'Error fetching appointments' });
    }
});

// Update appointment status
app.put('/api/admin/appointments/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;
    
    const validStatuses = ['scheduled', 'confirmed', 'completed', 'cancelled', 'no-show'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, message: 'Invalid status' });
    }
    
    try {
        const query = `
            UPDATE appointments 
            SET status = $1, notes = $2, updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `;
        
        const result = await pool.query(query, [status, notes, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Appointment not found' });
        }
        
        res.json({
            success: true,
            message: 'Appointment status updated successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating appointment:', error);
        res.status(500).json({ success: false, message: 'Error updating appointment' });
    }
});

// =========================
// DASHBOARD ANALYTICS APIs
// =========================

// Get dashboard statistics
app.get('/api/admin/stats', async (req, res) => {
    try {
        const stats = await Promise.all([
            // Total doctors
            pool.query('SELECT COUNT(*) as total FROM doctors WHERE is_active = true'),
            
            // Total appointments today
            pool.query(`
                SELECT COUNT(*) as total FROM appointments 
                WHERE appointment_date = CURRENT_DATE
            `),
            
            // Upcoming appointments (next 7 days)
            pool.query(`
                SELECT COUNT(*) as total FROM appointments 
                WHERE appointment_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
                AND status IN ('scheduled', 'confirmed')
            `),
            
            // Appointments by status
            pool.query(`
                SELECT status, COUNT(*) as count FROM appointments 
                WHERE appointment_date >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY status
            `),
            
            // Appointments by doctor (top 5)
            pool.query(`
                SELECT d.name, COUNT(a.id) as appointment_count
                FROM doctors d
                LEFT JOIN appointments a ON d.id = a.doctor_id 
                WHERE a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY d.id, d.name
                ORDER BY appointment_count DESC
                LIMIT 5
            `)
        ]);
        
        res.json({
            success: true,
            data: {
                totalDoctors: parseInt(stats[0].rows[0].total),
                todayAppointments: parseInt(stats[1].rows[0].total),
                upcomingAppointments: parseInt(stats[2].rows[0].total),
                appointmentsByStatus: stats[3].rows,
                topDoctors: stats[4].rows
            }
        });
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ success: false, message: 'Error fetching statistics' });
    }
});

// =========================
// PATIENT MANAGEMENT APIs
// =========================

// Update patient
app.put('/api/admin/patients/:id', async (req, res) => {
    const { id } = req.params;
    const { name, email, phone } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ 
            success: false, 
            message: 'Name and email are required' 
        });
    }
    
    try {
        const query = `
            UPDATE users 
            SET name = $1, email = $2, phone = $3
            WHERE id = $4
            RETURNING *
        `;
        
        const result = await pool.query(query, [name, email, phone, id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Patient not found' });
        }
        
        res.json({
            success: true,
            message: 'Patient updated successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating patient:', error);
        if (error.code === '23505') { // Unique constraint violation
            res.status(400).json({ success: false, message: 'Patient with this email already exists' });
        } else {
            res.status(500).json({ success: false, message: 'Error updating patient' });
        }
    }
});

// Create new patient
app.post('/api/admin/patients', async (req, res) => {
    const { name, email, phone } = req.body;
    
    if (!name || !email) {
        return res.status(400).json({ 
            success: false, 
            message: 'Name and email are required' 
        });
    }
    
    try {
        const query = `
            INSERT INTO users (name, email, phone)
            VALUES ($1, $2, $3)
            RETURNING *
        `;
        
        const result = await pool.query(query, [name, email, phone]);
        
        res.json({
            success: true,
            message: 'Patient created successfully',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('Error creating patient:', error);
        if (error.code === '23505') { // Unique constraint violation
            res.status(400).json({ success: false, message: 'Patient with this email already exists' });
        } else {
            res.status(500).json({ success: false, message: 'Error creating patient' });
        }
    }
});

// =========================
// REAL-WORLD CONSIDERATIONS
// =========================

/*
SECURITY CONSIDERATIONS:
1. Authentication middleware (JWT tokens)
2. Role-based access control
3. Input sanitization and validation
4. Rate limiting for admin endpoints
5. Audit logging for all admin actions

SCALABILITY CONSIDERATIONS:
1. Database connection pooling (already implemented)
2. Caching layer for frequently accessed data
3. Database indexing on commonly queried fields
4. Pagination for large datasets (implemented)

PRODUCTION DEPLOYMENT:
1. Separate admin and patient services
2. Load balancer with SSL termination
3. Database read replicas for reporting
4. Monitoring and alerting
5. Backup and disaster recovery

NEXT STEPS:
1. Add authentication middleware
2. Create admin frontend interface
3. Implement audit logging
4. Add data validation schemas
5. Set up monitoring and health checks
*/
// --- Start server ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏥 Medical Scheduler running at http://0.0.0.0:${PORT}`);
    console.log('📅 Ready to schedule appointments with AI!');
    console.log('🤖 AWS Bedrock Bearer Token integration enabled');
    console.log(`🌐 Access externally at: http://YOUR-EC2-PUBLIC-IP:${PORT}`);
});