const express = require('express');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
        // Generate AI response with database context
        const botResponse = await generateBotResponse(message);
        
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

// Enhanced AI response logic with database integration
async function generateBotResponse(userInput) {
    const input = userInput.toLowerCase();
    
    if (input.includes('appointment') || input.includes('schedule') || input.includes('book')) {
        // Get available doctors
        const doctors = await getAvailableDoctors();
        const actions = doctors.slice(0, 4).map(doc => ({
            type: 'button',
            text: `${doc.name} (${doc.specialty})`,
            action: 'select_doctor',
            data: doc.id
        }));
        
        return {
            content: "I'd be happy to help you schedule an appointment! Which doctor would you like to see?",
            actions: actions
        };
        
    } else if (input.includes('tomorrow') || input.includes('today') || input.includes('monday') || input.includes('tuesday')) {
        // Handle date requests
        const availableSlots = await getAvailableSlotsForDate(extractDateFromMessage(input));
        
        if (availableSlots.length > 0) {
            const actions = availableSlots.slice(0, 4).map(slot => ({
                type: 'button',
                text: `${slot.time} with ${slot.doctor_name}`,
                action: 'book_time',
                data: `${slot.doctor_id},${slot.date},${slot.time}`
            }));
            
            return {
                content: `Here are the available appointment times:`,
                actions: actions
            };
        } else {
            return {
                content: "I don't see any available slots for that day. Would you like to see other available dates?",
                actions: [
                    { type: 'button', text: 'Show next week', action: 'show_next_week' },
                    { type: 'button', text: 'Different doctor', action: 'show_doctors' }
                ]
            };
        }
        
    } else if (input.includes('doctor') || input.includes('cardiologist') || input.includes('dermatologist')) {
        // Handle doctor/specialty requests
        const specialty = extractSpecialtyFromMessage(input);
        const doctors = await getDoctorsBySpecialty(specialty);
        
        if (doctors.length > 0) {
            const actions = doctors.map(doc => ({
                type: 'button',
                text: `${doc.name} - ${doc.specialty}`,
                action: 'select_doctor',
                data: doc.id
            }));
            
            return {
                content: `I found these doctors for you:`,
                actions: actions
            };
        } else {
            return {
                content: "I couldn't find doctors for that specialty. Here are our available specialists:",
                actions: await getSpecialtyButtons()
            };
        }
        
    } else if (input.includes('representative') || input.includes('speak') || input.includes('help')) {
        return {
            content: "I can connect you with one of our representatives. Would you like to schedule a callback or get transferred?",
            actions: [
                { type: 'button', text: 'Schedule Callback', action: 'callback' },
                { type: 'button', text: 'Transfer to Representative', action: 'transfer' }
            ]
        };
    }
    
    return {
        content: "I'm here to help you schedule medical appointments. You can ask me to book with specific doctors, check availability for certain dates, or browse by specialty. What would you like to do?"
    };
}

// Database helper functions
async function getAvailableDoctors() {
    const query = `
        SELECT id, name, specialty, office_location
        FROM doctors 
        WHERE is_active = true 
        ORDER BY name
    `;
    const result = await pool.query(query);
    return result.rows;
}

async function getDoctorsBySpecialty(specialty) {
    const query = `
        SELECT id, name, specialty, office_location
        FROM doctors 
        WHERE is_active = true 
        AND specialty ILIKE $1
        ORDER BY name
    `;
    const result = await pool.query(query, [`%${specialty}%`]);
    return result.rows;
}

async function getAvailableSlotsForDate(targetDate) {
    // This is a simplified version - you'd want to generate 30-minute slots
    const query = `
        SELECT DISTINCT
            d.id as doctor_id,
            d.name as doctor_name,
            d.specialty,
            da.start_time,
            da.end_time,
            $1 as date
        FROM doctors d
        JOIN doctor_availability da ON d.id = da.doctor_id
        WHERE d.is_active = true
        AND da.is_active = true
        AND da.day_of_week = EXTRACT(DOW FROM $1::date)
        AND NOT EXISTS (
            SELECT 1 FROM appointments a 
            WHERE a.doctor_id = d.id 
            AND a.appointment_date = $1
            AND a.status IN ('scheduled', 'confirmed')
            AND a.appointment_time BETWEEN da.start_time AND da.end_time
        )
        ORDER BY da.start_time
        LIMIT 10
    `;
    
    const result = await pool.query(query, [targetDate]);
    return result.rows.map(row => ({
        ...row,
        time: row.start_time.slice(0, 5) // Format time as HH:MM
    }));
}

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
    // First try to find existing user
    let result = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    
    if (result.rows.length > 0) {
        return result.rows[0].id;
    }
    
    // Create new user
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

// Utility functions
function extractDateFromMessage(message) {
    const today = new Date();
    if (message.includes('tomorrow')) {
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        return tomorrow.toISOString().split('T')[0];
    }
    if (message.includes('today')) {
        return today.toISOString().split('T')[0];
    }
    // Add more date parsing logic as needed
    return today.toISOString().split('T')[0];
}

function extractSpecialtyFromMessage(message) {
    const specialties = {
        'heart': 'cardiology',
        'skin': 'dermatology', 
        'bone': 'orthopedics',
        'joint': 'orthopedics',
        'diabetes': 'endocrinology',
        'family': 'family medicine'
    };
    
    for (const [keyword, specialty] of Object.entries(specialties)) {
        if (message.includes(keyword)) {
            return specialty;
        }
    }
    return '';
}

async function getSpecialtyButtons() {
    const specialties = await pool.query('SELECT DISTINCT specialty FROM doctors WHERE is_active = true');
    return specialties.rows.map(row => ({
        type: 'button',
        text: row.specialty,
        action: 'select_specialty',
        data: row.specialty
    }));
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🏥 Medical Scheduler running at http://0.0.0.0:${PORT}`);
    console.log(`📅 Ready to schedule appointments!`);
    console.log(`🌐 Access externally at: http://YOUR-EC2-PUBLIC-IP:${PORT}`);
});