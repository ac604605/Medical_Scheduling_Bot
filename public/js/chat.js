class ChatInterface {
    constructor() {
        this.messages = [];
        this.init();
    }

    init() {
        this.chatMessages = document.getElementById('chatMessages');
        this.messageInput = document.getElementById('messageInput');
        this.sendBtn = document.getElementById('sendBtn');
        this.typingIndicator = document.getElementById('typingIndicator');

        // Event listeners
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendMessage();
        });

        // Quick action buttons
        document.querySelectorAll('.quick-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.messageInput.value = btn.dataset.message;
                this.sendMessage();
            });
        });

        // Input state management
        this.messageInput.addEventListener('input', () => {
            this.sendBtn.disabled = !this.messageInput.value.trim();
        });
        
        this.sendBtn.disabled = true;
    }

    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message) return;

        // Add user message to UI
        this.addMessage('user', message);
        this.messageInput.value = '';
        this.sendBtn.disabled = true;

        // Show typing indicator
        this.showTypingIndicator();

        try {
            // Send message to server
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ message })
            });

            const data = await response.json();

            if (data.success) {
                // Hide typing indicator and show bot response
                this.hideTypingIndicator();
                this.addMessage('bot', data.response.content, data.response.actions);
            } else {
                throw new Error('Failed to get response');
            }
        } catch (error) {
            console.error('Error sending message:', error);
            this.hideTypingIndicator();
            this.addMessage('bot', 'Sorry, I encountered an error. Please try again.');
        }
    }

    addMessage(type, content, actions = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}-message`;

        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';

        const messageParagraph = document.createElement('p');
        messageParagraph.textContent = content;

        const messageTime = document.createElement('span');
        messageTime.className = 'message-time';
        messageTime.textContent = this.formatTime(new Date());

        messageContent.appendChild(messageParagraph);
        messageContent.appendChild(messageTime);

        // Add action buttons if they exist
        if (actions && actions.length > 0) {
            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'message-actions';

            actions.forEach(action => {
                const button = document.createElement('button');
                button.className = 'action-btn';
                button.textContent = action.text;
                button.addEventListener('click', () => this.handleActionClick(action));
                actionsDiv.appendChild(button);
            });

            messageContent.appendChild(actionsDiv);
        }

        messageDiv.appendChild(messageContent);
        this.chatMessages.appendChild(messageDiv);
        
        this.scrollToBottom();

        // Re-initialize Lucide icons for any new icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    }

    handleActionClick(action) {
        let responseMessage = '';
        
        switch (action.action) {
            case 'consultation':
                this.addMessage('user', 'I need a consultation');
                break;
            case 'followup':
                this.addMessage('user', 'I need a follow-up visit');
                break;
            case 'procedure':
                this.addMessage('user', 'I need to schedule a procedure');
                break;
            case 'book_time':
                responseMessage = `I'd like to book ${action.text}`;
                this.addMessage('user', responseMessage);
                this.simulateBotResponse('Perfect! I\'ve reserved that time slot for you. To complete your booking, I\'ll need some basic information. Can you provide your full name and email address?');
                return;
            case 'more_times':
                responseMessage = 'Show me more available times';
                break;
            case 'callback':
                responseMessage = 'I\'d like to schedule a callback';
                break;
            case 'live_chat':
                responseMessage = 'Connect me to live chat';
                break;
            default:
                responseMessage = action.text;
        }
        
        if (responseMessage) {
            this.messageInput.value = responseMessage;
            this.sendMessage();
        }
    }

    simulateBotResponse(message, actions = null) {
        this.showTypingIndicator();
        setTimeout(() => {
            this.hideTypingIndicator();
            this.addMessage('bot', message, actions);
        }, 1000);
    }

    showTypingIndicator() {
        this.typingIndicator.style.display = 'flex';
        this.scrollToBottom();
    }

    hideTypingIndicator() {
        this.typingIndicator.style.display = 'none';
    }

    scrollToBottom() {
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    formatTime(date) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}

// Initialize chat interface when page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChatInterface();
});