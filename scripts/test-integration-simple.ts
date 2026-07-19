// Simple integration test: Does Twilio stream trigger OpenAI connection?
import WebSocket from 'ws';

console.log('🧪 Simple Integration Test\n');
console.log('Testing: Twilio stream → OpenAI session creation\n');

const WS_URL = 'ws://localhost:5050/twilio/stream';

let testPassed = false;

console.log('1️⃣  Connecting to /twilio/stream...');
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ WebSocket connected\n');

  console.log('2️⃣  Sending Twilio "start" event...');
  ws.send(JSON.stringify({
    event: 'start',
    streamSid: 'TEST_' + Date.now(),
    start: {
      streamSid: 'TEST_STREAM',
      callSid: 'TEST_CALL',
      accountSid: 'TEST_ACCOUNT'
    }
  }));

  console.log('✅ Start event sent\n');
  console.log('3️⃣  Check server logs for:');
  console.log('   - "📞 ========== NEW CALL STARTED =========="');
  console.log('   - "OpenAI WebSocket connection established"');
  console.log('   - "✅ OpenAI session configured"\n');

  setTimeout(() => {
    console.log('4️⃣  Sending a few audio frames...\n');
    for (let i = 0; i < 10; i++) {
      // Send some audio with high energy to trigger speech detection
      const audioBuffer = Buffer.alloc(160);
      for (let j = 0; j < 160; j++) {
        audioBuffer[j] = Math.floor(Math.random() * 200 + 28); // Higher amplitude
      }

      ws.send(JSON.stringify({
        event: 'media',
        streamSid: 'TEST_STREAM',
        media: {
          track: 'inbound',
          chunk: i.toString(),
          timestamp: (Date.now() + i * 20).toString(),
          payload: audioBuffer.toString('base64')
        }
      }));
    }

    console.log('✅ Sent 10 audio frames\n');
    console.log('5️⃣  Check server logs for:');
    console.log('   - "Speech detected, buffering audio" (if RMS > 80)');
    console.log('   - "Speech started detected by OpenAI VAD"');
    console.log('   - "Speech stopped detected by OpenAI VAD"');
    console.log('   - "🤖 OpenAI response created"');
    console.log('   - "🎵 Audio delta received from OpenAI"\n');

    setTimeout(() => {
      console.log('\n📊 Test Complete!\n');
      console.log('✅ If you saw the logs above in your server terminal:');
      console.log('   → Integration is working!');
      console.log('   → OpenAI session was created');
      console.log('   → Audio is flowing\n');

      console.log('❌ If you did NOT see those logs:');
      console.log('   → Check that server is running');
      console.log('   → Check for errors in server logs');
      console.log('   → Audio might not have enough energy to trigger VAD\n');

      ws.close();
      process.exit(0);
    }, 3000);
  }, 1000);
});

ws.on('error', (error: Error) => {
  console.error('\n❌ Connection failed:', error.message);
  console.log('💡 Is the server running? Try: npm run dev\n');
  process.exit(1);
});

ws.on('close', () => {
  console.log('Connection closed');
});
