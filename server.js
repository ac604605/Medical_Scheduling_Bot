const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// AWS Bedrock client setup
const bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Database connection
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 5432,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Error connecting to database:', err);
    } else {
        console.log('✅ Connected to PostgreSQL database');
        release();
    }
});

// Set view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/', (req, res) => {
    res.render('index', { 
        title: 'HealthCare Scheduler',
        subtitle: 'AI-Powered Appointment Booking'
    });
});

// API endpoint for chat messages
app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    
    try {
        // Get database context for AI
        const dbContext = await getDatabaseContext();
        
        // Generate AI response using Bedrock
        const botResponse = await generateAIResponse(message, dbContext);
        
        res.json({
            success: true,
            response: botResponse
        });
    } catch (error) {
        console.error('Error processing chat message:', error);
        res.status(500).json({
            success: false,
            error: 'Sorry, I encountered an error processing your request.'
        });
    }
});

// Enhanced AI response using AWS Bedrock Nova Micro
async function generateAIResponse(userMessage, dbContext) {
    const systemPrompt = `# Medical Scheduling Assistant System Prompt

## ROLE AND PURPOSE
You are a specialized medical appointment scheduling assistant for a healthcare practice. Your ONLY purpose is to help patients schedule, reschedule, or check appointments. You should be professional, helpful, and empathetic while maintaining strict focus on scheduling-related tasks.

## CORE RESPONSIBILITIES
1. **Schedule new appointments** (consultations, follow-ups, procedures, specialist visits)
2. **Check appointment availability** against the provided schedule database
3. **Handle appointment modifications** (reschedule, cancel)
4. **Provide clear information** about available time slots
5. **Collect necessary patient information** for booking (name, contact info, appointment type, preferred dates/times)

## COMMUNICATION STYLE
- **Tone**: Professional yet warm and approachable
- **Language**: Use simple, clear language while understanding medical terminology
- **Patience**: Be understanding of patient confusion or anxiety
- **Efficiency**: Guide conversations toward successful appointment booking

## HANDLING MEDICAL TERMINOLOGY
- **Understand**: Recognize complex medical terms, specialty names, procedure types
- **Translate**: Explain medical terms in simple language when needed

## SCHEDULING CONFLICT RESPONSES
When requested times are unavailable, respond with:
1. **Acknowledge the request**: "I understand you'd prefer [requested time]"
2. **Explain unavailability**: "Unfortunately, that slot is already booked"
3. **Offer alternatives**: "I have these available times nearby: [list 2-3 options]"
4. **Ask for preference**: "Which of these would work better for you?"

## OFF-TOPIC CONVERSATION MANAGEMENT

### First Redirect (Gentle)
"I'd be happy to help with that, but I'm specifically designed to assist with appointment scheduling. Let's get you booked first - what type of appointment are you looking to schedule?"

### Second Redirect (Firmer)
"I understand you have other questions, but my expertise is really in scheduling appointments. Once you're booked, your doctor or our clinical staff can address those concerns during your visit. Shall we find you an appointment time?"

### Third Redirect (Offer Human Help)
"I can see you have questions beyond scheduling. Would you like me to connect you with one of our patient representatives who can better assist you with those concerns?"

## RESPONSE FORMAT
Always respond in JSON format with:
{
  "content": "Your response message here",
  "actions": [
    {"type": "button", "text": "Button text", "action": "action_type", "data": "action_data"}
  ]
}

Actions can be:
- select_doctor (data: doctor_id)
- select_specialty (data: specialty_name)
- book_time (data: "doctor_id,date,time")
- show_more_times
- callback
- transfer

## CURRENT DATABASE CONTEXT:
${JSON.stringify(dbContext, null, 2)}

Based on this information, help the patient with their scheduling needs.`;

    const payload = {
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: `${systemPrompt}\n\nPatient message: "${userMessage}"`
                    }
                ]
            }
        ],
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.9
    };

    try {
        const command = new InvokeModelCommand({
            modelId: "us.amazon.nova-micro-v1:0", // Nova Micro model
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload)
        });

        const response = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        
        // Extract the AI response
        const aiResponse = responseBody.output.message.content[0].text;
        
        // Try to parse as JSON, fallback to simple response if it fails
        try {
            return JSON.parse(aiResponse);
        } catch (parseError) {
            // If AI didn't return valid JSON, create a simple response
            return {
                content: aiResponse,
                actions: []
            };
        }
        
    } catch (error) {
        console.error('Error calling Bedrock:', error);
        
        // Fallback to simple response if Bedrock fails
        return generateFallbackResponse(userMessage, dbContext);
    }
}

// Fallback response function if Bedrock is unavailable
function generateFallbackResponse(userInput, dbContext) {
    const input = userInput.toLowerCase();
    
    if (input.includes('appointment') || input.includes('schedule') || input.includes('book')) {
        const actions = dbContext.doctors.slice(0, 4).map(doc => ({
            type: 'button',
            text: `${doc.name} (${doc.specialty})`,
            action: 'select_doctor',
            data: doc.id.toString()
        }));
        
        return {
            content: "I'd be happy to help you schedule an appointment! Which doctor would you like to see?",
            actions: actions
        };
    }
    
    return {
        content: "I'm here to help you schedule medical appointments. You can ask me to book with specific doctors, check availability for certain dates, or browse by specialty. What would you like to do?",
        actions: []
    };
}

// Get database context for AI
async function getDatabaseContext() {
    try {
        // Get available doctors
        const doctorsQuery = `
            SELECT id, name, specialty, office_location
            FROM doctors 
            WHERE is_active = true 
            ORDER BY name
        `;
        const doctorsResult = await pool.query(doctorsQuery);
        
        // Get today's date for context
        const today = new Date().toISOString().split('T')[0];
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowDate = tomorrow.toISOString().split('T')[0];
        
        // Get upcoming availability (next 7 days)
        const availabilityQuery = `
            SELECT DISTINCT
                d.id as doctor_id,
                d.name as doctor_name,
                d.specialty,
                da.start_time,
                da.end_time,
                (CURRENT_DATE + INTERVAL '1 day' * generate_series(0, 6)) as available_date
            FROM doctors d
            JOIN doctor_availability da ON d.id = da.doctor_id
            WHERE d.is_active = true
            AND da.is_active = true
            AND da.day_of_week = EXTRACT(DOW FROM CURRENT_DATE + INTERVAL '1 day' * generate_series(0, 6))
            ORDER BY available_date, start_time
            LIMIT 20
        `;
        const availabilityResult = await pool.query(availabilityQuery);
        
        // Get existing appointments for context
        const appointmentsQuery = `
            SELECT 
                a.appointment_date,
                a.appointment_time,
                d.name as doctor_name,
                u.name as patient_name
            FROM appointments a
            JOIN doctors d ON a.doctor_id = d.id
            JOIN users u ON a.user_id = u.id
            WHERE a.appointment_date >= CURRENT_DATE
            AND a.appointment_date <= CURRENT_DATE + INTERVAL '7 days'
            AND a.status IN ('scheduled', 'confirmed')
            ORDER BY a.appointment_date, a.appointment_time
        `;
        const appointmentsResult = await pool.query(appointmentsQuery);
        
        return {
            doctors: doctorsResult.rows,
            upcoming_availability: availabilityResult.rows,
            existing_appointments: appointmentsResult.rows,
            current_date: today,
            tomorrow_date: tomorrowDate
        };
        
    } catch (error) {
        console.error('Error getting database context:', error);
        return {
            doctors: [],
            upcoming_availability: [],
            existing_appointments: [],
            current_date: new Date().toISOString().split('T')[0],
            tomorrow_date: new Date(Date.now() + 86400000).toISOString().split('T')[0]
        };
    }
}

// API endpoint for booking appointments
app.post('/api/book-appointment', async (req, res) => {
    const { patientName, email, phone, doctorId, appointmentTypeId, appointmentDate, appointmentTime, reasonForVisit } = req.body;
    
    try {
        // Check if time slot is available
        const availability = await checkTimeSlotAvailability(doctorId, appointmentDate, appointmentTime);
        
        if (!availability.available) {
            return res.json({
                success: false,
                message: 'Sorry, that time slot is no longer available.',
                alternatives: await getSuggestedAlternatives(doctorId, appointmentDate)
            });
        }
        
        // Create or find user
        let userId = await findOrCreateUser(patientName, email, phone);
        
        // Book the appointment
        const appointment = await bookAppointment({
            userId,
            doctorId,
            appointmentTypeId,
            appointmentDate,
            appointmentTime,
            reasonForVisit
        });
        
        res.json({
            success: true,
            message: 'Appointment booked successfully!',
            appointment: appointment
        });
        
    } catch (error) {
        console.error('Error booking appointment:', error);
        res.status(500).json({
            success: false,
            message: 'Sorry, there was an error booking your appointment. Please try again.'
        });
    }
});

// Database helper functions (keeping existing ones)
async function checkTimeSlotAvailability(doctorId, date, time) {
    const query = `
        SELECT 
            CASE 
                WHEN COUNT(*) = 0 THEN true
                ELSE false
            END as available
        FROM (
            SELECT 1 FROM appointments 
            WHERE doctor_id = $1 
            AND appointment_date = $2 
            AND appointment_time = $3
            AND status IN ('scheduled', 'confirmed')
            
            UNION ALL
            
            SELECT 1 FROM blocked_slots
            WHERE doctor_id = $1
            AND blocked_date = $2
            AND $3 BETWEEN start_time AND end_time
        ) conflicts
    `;
    
    const result = await pool.query(query, [doctorId, date, time]);
    return { available: result.rows[0].available };
}

async function findOrCreateUser(name, email, phone) {
    let result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    
    if (result.rows.length > 0) {
        return result.rows[0].id;
    }
    
    result = await pool.query(
        'INSERT INTO users (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [name, email, phone]
    );
    
    return result.rows[0].id;
}

async function bookAppointment({ userId, doctorId, appointmentTypeId, appointmentDate, appointmentTime, reasonForVisit }) {
    const query = `
        INSERT INTO appointments (
            user_id, doctor_id, appointment_type_id, 
            appointment_date, appointment_time, reason_for_visit, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'scheduled')
        RETURNING id, confirmation_number
    `;
    
    const result = await pool.query(query, [
        userId, doctorId, appointmentTypeId || 1, 
        appointmentDate, appointmentTime, reasonForVisit
    ]);
    
    return result.rows[0];
}

async function getSuggestedAlternatives(doctorId, preferredDate) {
    // Simple implementation - you can enhance this
    const query = `
        SELECT DISTINCT
            da.start_time,
            (CURRENT_DATE + INTERVAL '1 day' * generate_series(0, 6)) as available_date
        FROM doctor_availability da
        WHERE da.doctor_id = $1
        AND da.is_active = true
        ORDER BY available_date, start_time
        LIMIT 5
    `;
    
    const result = await pool.query(query, [doctorId]);
    return result.rows;
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏥 Medical Scheduler running at http://0.0.0.0:${PORT}`);
    console.log(`📅 Ready to schedule appointments with AI!`);
    console.log(`🤖 AWS Bedrock Nova Micro integration enabled`);
    console.log(`🌐 Access externally at: http://YOUR-EC2-PUBLIC-IP:${PORT}`);
});