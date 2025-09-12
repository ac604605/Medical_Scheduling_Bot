// Replace your generateAIResponse function with this smart interpreter approach
async function generateAIResponse(userMessage, dbContext) {
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
- Format: "Great! I found Dr. [Full Name] in [Specialty]. Available dates: [clickable options]"

### SPECIALTY REQUESTS
When user asks for specialty:
- Show doctors in that specialty with available times
- Format as selectable options

### DATE/TIME REQUESTS  
When user specifies dates:
- Check availability against database
- Provide time slot options
- Make times clickable for selection

## RESPONSE FORMAT
Always return JSON:
{
  "content": "Your response text",
  "actions": [
    {"type": "select_doctor", "text": "Dr. Johnson (Cardiology)", "data": "doctor_id"},
    {"type": "select_date", "text": "Tomorrow 2:00 PM", "data": "doctor_id,date,time"},
    {"type": "select_specialty", "text": "Cardiology", "data": "specialty"},
    {"type": "book_appointment", "text": "Book This Appointment", "data": "booking_data"}
  ]
}

## CURRENT DATA
Doctors: ${JSON.stringify(dbContext.doctors, null, 2)}
Availability: ${JSON.stringify(dbContext.upcoming_availability.slice(0, 10), null, 2)}

## EXAMPLE INTERACTIONS

User: "I want to see Dr. Johnson"
Response: Search doctors for "Johnson", if found: "I found Dr. Sarah Johnson in Oncology. She's available: [Tomorrow 2:00 PM] [Friday 10:30 AM] [Monday 3:15 PM]"

User: "I need a cardiologist"  
Response: "Our cardiology specialists are: [Dr. Smith] [Dr. Brown]. Which would you prefer?"

User: "Schedule me for tomorrow afternoon"
Response: "I have these afternoon slots tomorrow: [Dr. Johnson 2:00 PM] [Dr. Smith 3:30 PM] [Dr. Brown 4:00 PM]"

Keep responses short, focused, and actionable. Always provide clickable options when possible.`;

    const payload = {
        messages: [
            {
                role: "user",
                content: [
                    {
                        text: `${systemPrompt}\n\nUser says: "${userMessage}"\n\nProvide a helpful response with actionable options.`
                    }
                ]
            }
        ],
        inferenceConfig: {
            maxTokens: 800,
            temperature: 0.3, // Lower temperature for more consistent structured responses
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
                timeout: 30000
            }
        );

        const aiRaw = extractTextFromBedrockResponse(response);
        if (!aiRaw) {
            return generateSmartFallback(userMessage, dbContext);
        }

        try {
            return JSON.parse(aiRaw);
        } catch {
            // If AI doesn't return JSON, create smart response based on user input
            return generateSmartFallback(userMessage, dbContext, aiRaw);
        }
    } catch (error) {
        console.error('Error calling Bedrock:', (error.response && error.response.data) || error.message);
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