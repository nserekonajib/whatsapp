from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import requests
import json
import time
import qrcode
import io
import base64
from threading import Thread
from supabase import create_client, Client
import os
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

NODE_SERVER = "https://whatsapp-jgoj.onrender.com"

# Initialize Supabase client
supabase_url = os.getenv('SUPABASE_URL')
supabase_key = os.getenv('SUPABASE_KEY')
supabase: Client = None

if supabase_url and supabase_key:
    supabase = create_client(supabase_url, supabase_key)
    print("✅ Supabase connected")
else:
    print("⚠️ Supabase not configured")

# Global variables
messages = []
current_qr_string = None
current_qr_image = None
is_connected = False

def generate_qr_image(qr_string):
    """Generate QR code image from string"""
    try:
        qr = qrcode.QRCode(version=1, box_size=10, border=5)
        qr.add_data(qr_string)
        qr.make(fit=True)
        
        img = qr.make_image(fill_color="#075E54", back_color="white")
        
        # Convert to base64 for web display
        buffered = io.BytesIO()
        img.save(buffered, format="PNG")
        img_str = base64.b64encode(buffered.getvalue()).decode()
        return f"data:image/png;base64,{img_str}"
    except Exception as e:
        print(f"QR generation error: {e}")
        return None

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def get_status():
    global current_qr_string, current_qr_image
    
    try:
        response = requests.get(f"{NODE_SERVER}/api/status", timeout=2)
        data = response.json()
        
        # If we have QR string but no image yet, generate it
        if data.get('qrCode') and data.get('qrCode') != current_qr_string:
            current_qr_string = data.get('qrCode')
            current_qr_image = generate_qr_image(current_qr_string)
            # Emit to all connected clients
            socketio.emit('qr', current_qr_image)
        
        return jsonify(data)
    except Exception as e:
        return jsonify({'ready': False, 'qrCode': None, 'error': str(e)})

@app.route('/api/send', methods=['POST'])
def send_message():
    try:
        response = requests.post(f"{NODE_SERVER}/api/send", json=request.json, timeout=10)
        return jsonify(response.json())
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/logout', methods=['POST'])
def logout():
    """Forward logout request to Node.js server"""
    try:
        print("🔴 Logout request received, forwarding to Node.js...")
        response = requests.post(f"{NODE_SERVER}/api/logout", timeout=10)
        
        # Reset global state
        global current_qr_string, current_qr_image, is_connected
        current_qr_string = None
        current_qr_image = None
        is_connected = False
        
        # Emit disconnect event to all clients
        socketio.emit('disconnected', 'Logged out manually')
        
        return jsonify(response.json())
    except requests.exceptions.ConnectionError:
        print("❌ Cannot connect to Node.js server")
        return jsonify({'success': False, 'error': 'Node.js server not reachable'}), 500
    except Exception as e:
        print(f"Logout error: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/messages')
def get_messages():
    """Get messages from Supabase with pagination"""
    try:
        # Get pagination parameters
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 10))
        user_id = request.args.get('user_id', None)
        
        # Calculate offset
        offset = (page - 1) * per_page
        
        # Query Supabase
        if supabase:
            query = supabase.table('whatsapp_messages').select('*', count='exact')
            
            # Filter by user_id if provided
            if user_id:
                query = query.eq('user_id', user_id)
            
            # Order by timestamp descending and apply pagination
            result = query.order('timestamp', desc=True).range(offset, offset + per_page - 1).execute()
            
            messages_data = result.data
            total_count = result.count
            
            # Format messages for display
            formatted_messages = []
            for msg in messages_data:
                formatted_messages.append({
                    'id': msg.get('id'),
                    'user_id': msg.get('user_id'),
                    'message': msg.get('message'),
                    'response': msg.get('response'),
                    'message_type': msg.get('message_type'),
                    'timestamp': msg.get('timestamp')
                })
            
            return jsonify({
                'success': True,
                'messages': formatted_messages,
                'total': total_count,
                'page': page,
                'per_page': per_page,
                'total_pages': (total_count + per_page - 1) // per_page if total_count else 0
            })
        else:
            # Fallback to memory storage
            return jsonify({
                'success': True,
                'messages': [],
                'total': 0,
                'page': 1,
                'per_page': per_page,
                'total_pages': 0,
                'message': 'Supabase not configured, using memory storage'
            })
    except Exception as e:
        print(f"Error fetching messages: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/messages/stats')
def get_message_stats():
    """Get message statistics"""
    try:
        if supabase:
            # Get total messages count
            total_result = supabase.table('whatsapp_messages').select('*', count='exact', head=True).execute()
            total_messages = total_result.count
            
            # Get unique users count
            users_result = supabase.table('whatsapp_messages').select('user_id').execute()
            unique_users = len(set([msg['user_id'] for msg in users_result.data]))
            
            # Get today's messages
            from datetime import datetime, timedelta
            today = datetime.now().date()
            today_result = supabase.table('whatsapp_messages')\
                .select('*', count='exact')\
                .gte('timestamp', today.isoformat())\
                .execute()
            today_messages = today_result.count
            
            return jsonify({
                'success': True,
                'total_messages': total_messages or 0,
                'unique_users': unique_users,
                'today_messages': today_messages or 0
            })
        else:
            return jsonify({
                'success': True,
                'total_messages': 0,
                'unique_users': 0,
                'today_messages': 0,
                'message': 'Supabase not configured'
            })
    except Exception as e:
        print(f"Error getting stats: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/messages/user/<user_id>')
def get_user_messages(user_id):
    """Get messages for a specific user with pagination"""
    try:
        page = int(request.args.get('page', 1))
        per_page = int(request.args.get('per_page', 10))
        offset = (page - 1) * per_page
        
        if supabase:
            result = supabase.table('whatsapp_messages')\
                .select('*', count='exact')\
                .eq('user_id', user_id)\
                .order('timestamp', desc=True)\
                .range(offset, offset + per_page - 1)\
                .execute()
            
            return jsonify({
                'success': True,
                'messages': result.data,
                'total': result.count,
                'page': page,
                'per_page': per_page
            })
        else:
            return jsonify({'success': False, 'error': 'Supabase not configured'}), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/qr-image')
def get_qr_image():
    """Endpoint to get QR code as image"""
    if current_qr_image:
        return jsonify({'qrImage': current_qr_image})
    return jsonify({'qrImage': None})

# Socket.IO events
@socketio.on('connect')
def handle_connect():
    print('Client connected to Flask')
    # Send current QR if available
    if current_qr_image:
        emit('qr', current_qr_image)
    if is_connected:
        emit('ready', 'Connected')
    emit('connected', {'status': 'connected'})

# Background thread to poll Node.js for updates
def poll_node_updates():
    global current_qr_string, current_qr_image, is_connected
    
    while True:
        try:
            # Get status
            resp = requests.get(f"{NODE_SERVER}/api/status", timeout=2)
            if resp.status_code == 200:
                data = resp.json()
                
                # Check for new QR code
                if data.get('qrCode') and data.get('qrCode') != current_qr_string:
                    current_qr_string = data.get('qrCode')
                    current_qr_image = generate_qr_image(current_qr_string)
                    if current_qr_image:
                        socketio.emit('qr', current_qr_image)
                        print("📱 New QR code generated and sent to web interface")
                
                # Check connection status
                if data.get('ready') != is_connected:
                    is_connected = data.get('ready')
                    if is_connected:
                        socketio.emit('ready', 'Connected')
                        print("✅ WhatsApp connected!")
                    else:
                        socketio.emit('disconnected', 'Disconnected')
                        print("❌ WhatsApp disconnected")
        except Exception as e:
            print(f"Poll error: {e}")
        
        time.sleep(2)

# Start background thread
thread = Thread(target=poll_node_updates, daemon=True)
thread.start()

if __name__ == '__main__':
    print("\n" + "="*50)
    print("🚀 WhatsApp Bot Manager Starting...")
    print("="*50)
    print("📱 Flask Server: http://localhost:5000")
    print("🔗 Make sure Node.js server is running on port 3000")
    print("="*50 + "\n")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000, allow_unsafe_werkzeug=True)
