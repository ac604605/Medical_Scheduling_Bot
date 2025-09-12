// Chat functionality for Medical Scheduler
class ChatInterface {
    constructor() {
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.chatMessages = document.getElementById('chatMessages');
        this.typingIndicator = document.getElementById('typingIndicator');
        
        this.initializeEventListeners();
    }
    
    initializeEventListeners() {
        // Send button click
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        
        // Enter key press
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.sendMessage();
            }
        });
        
        // Quick action buttons
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const message = e.target.getAttribute('data-message');
                this.sendMessage(message);
            });
        });
    }
    
    async sendMessage(text = null) {
        const message = text || this.messageInput.value.trim();
        if (!message) return;
        
        // Clear input
        if (!text) this.messageInput.value = '';
        
        // Add user message to chat
        this.addMessage(message, 'user');
        
        // Show typing indicator
        this.showTypingIndicator();
        
        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message })
            });
            
            const data = await response.json();
            
            if (data.success && data.response) {
                this.addBotResponse(data.response);
            } else {
                this.addMessage('Sorry, I encountered an error. Please try again.', 'bot');
            }
        } catch (error) {
            console.error('Chat error:', error);
            this.addMessage('Sorry, I encountered an error. Please try again.', 'bot');
        } finally {
            this.hideTypingIndicator();
        }
    }
    
    addMessage(text, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}-message`;
        
        const timestamp = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        messageDiv.innerHTML = `
            <div class="message-content">
                <p>${this.escapeHtml(text)}</p>
                <span class="message-time">${timestamp}</span>
            </div>
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }
    
    addBotResponse(response) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot-message';
        
        const timestamp = new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        let actionsHtml = '';
        if (response.actions && response.actions.length > 0) {
            actionsHtml = '<div class="message-actions">';
            response.actions.forEach(action => {
                actionsHtml += `
                    <button class="action-btn" 
                            data-type="${action.type}" 
                            data-data="${action.data}"
                            onclick="chatInterface.handleActionClick(this)">
                        ${this.escapeHtml(action.text)}
                    </button>
                `;
            });
            actionsHtml += '</div>';
        }
        
        messageDiv.innerHTML = `
            <div class="message-content">
                <p>${this.escapeHtml(response.content)}</p>
                <span class="message-time">${timestamp}</span>
            </div>
            ${actionsHtml}
        `;
        
        this.chatMessages.appendChild(messageDiv);
        this.scrollToBottom();
    }
    
    async handleActionClick(button) {
    // Prevent multiple clicks
    if (button.disabled) return;

    const actionType = button.getAttribute('data-type');
    const actionData = button.getAttribute('data-data');

    // Disable the button to prevent double-clicks
    document.querySelectorAll('.action-btn').forEach(btn => {
        btn.disabled = true;
        if (btn === button) btn.textContent = 'Processing...';
    });

    try {
        let response;
    
        if (actionType === 'select_doctor') {
            response = await fetch('/api/select-doctor', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ doctorId: actionData })
            });
        } else if (actionType === 'select_date') {
            response = await fetch('/api/select-appointment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appointmentData: actionData })
            });
        } else if (actionType === 'collect_info') {
            response = await fetch('/api/complete-booking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appointmentData: actionData })
            });
        } else if (actionType === 'show_email') {
            this.addMessage(actionData, 'bot');
            return;
        } else if (actionType === 'download_calendar') {
            window.open(actionData, '_blank');
            this.addMessage('Calendar file download started! Check your downloads folder.', 'bot');
            return;
        } else if (actionType === 'start_over') {
            this.addMessage('How can I help you schedule your next appointment?', 'bot');
            return;
        } else {
            // For other action types, treat as a regular message
            this.sendMessage(button.textContent);
            return;
        }

        // Handle the response for API calls
        const data = await response.json();
        
        if (data.success && data.response) {
            this.addBotResponse(data.response);
        } else {
            this.addMessage(data.message || 'Sorry, something went wrong.', 'bot');
        }
        
    } catch (error) {
        console.error('Action error:', error);
        this.addMessage('Sorry, I encountered an error processing your request.', 'bot');
    }
}
        
			const data = await response.json();
        
			if (data.success && data.response) {
				this.addBotResponse(data.response);
			} else {
				this.addMessage(data.message || 'Sorry, something went wrong.', 'bot');
			}
        
		} catch (error) {
			console.error('Action error:', error);
			this.addMessage('Sorry, I encountered an error processing your request.', 'bot');

	}
	}
    
    showTypingIndicator() {
        this.typingIndicator.style.display = 'block';
        this.scrollToBottom();
    }
    
    hideTypingIndicator() {
        this.typingIndicator.style.display = 'none';
    }
    
    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }
    
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

// Initialize chat interface when page loads
let chatInterface;
document.addEventListener('DOMContentLoaded', () => {
    chatInterface = new ChatInterface();
});