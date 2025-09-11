const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

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
app.post('/api/chat', (req, res) => {
    const { message } = req.body;
    
    // Simulate AI response (later you'll connect this to AWS Bedrock)
    const botResponse = generateBotResponse(message);
    
    res.json({
        success: true,
        response: botResponse
    });
});

// API endpoint for booking appointments
app.post('/api/book-appointment', (req, res) => {
    const { patientName, email, appointmentType, dateTime } = req.body;
    
    // Here you'll integrate with AWS RDS/DynamoDB
    console.log('Booking appointment:', { patientName, email, appointmentType, dateTime });
    
    res.json({
        success: true,
        message: 'Appointment booked successfully!',
        confirmationNumber: 'HC' + Date.now()
    });
});

// Simple AI response logic (replace with AWS Bedrock later)
function generateBotResponse(userInput) {
    const input = userInput.toLowerCase();
    
    if (input.includes('appointment') || input.includes('schedule') || input.includes('book')) {
        return {
            content: "I'd be happy to help you schedule an appointment! What type of appointment are you looking for?",
            actions: [
                { type: 'button', text: 'General Consultation', action: 'consultation' },
                { type: 'button', text: 'Follow-up Visit', action: 'followup' },
                { type: 'button', text: 'Procedure', action: 'procedure' }
            ]
        };
    } else if (input.includes('consultation')) {
        return {
            content: "Great choice! I have several available slots for consultations this week. Which time works best for you?",
            actions: [
                { type: 'button', text: 'Tomorrow 10:00 AM', action: 'book_time', data: 'tomorrow-10am' },
                { type: 'button', text: 'Friday 2:30 PM', action: 'book_time', data: 'friday-230pm' },
                { type: 'button', text: 'Next Monday 9:00 AM', action: 'book_time', data: 'monday-9am' },
                { type: 'button', text: 'Show more times', action: 'more_times' }
            ]
        };
    } else if (input.includes('representative') || input.includes('speak')) {
        return {
            content: "I can connect you with one of our representatives. Would you like to schedule a callback or join our live chat queue?",
            actions: [
                { type: 'button', text: 'Schedule Callback', action: 'callback' },
                { type: 'button', text: 'Join Live Chat', action: 'live_chat' }
            ]
        };
    }
    
    return {
        content: "I understand you're asking about scheduling. I can help you book appointments, check availability, speak with representatives, or answer general questions. What would you like to do?"
    };
}

app.listen(PORT, () => {
    console.log(`🏥 Medical Scheduler running at http://localhost:${PORT}`);
    console.log(`📅 Ready to schedule appointments!`);
});