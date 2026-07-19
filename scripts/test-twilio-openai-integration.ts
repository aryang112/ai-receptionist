// Test script to verify Twilio <-> OpenAI integration
import WebSocket from 'ws';
import { readFileSync } from 'fs';

console.log('🧪 Testing Twilio <-> OpenAI Integration...\n');

const WS_URL = 'ws://localhost:5050/twilio/stream';
const FAKE_STREAM_SID = 'TEST_STREAM_' + Date.now();
const FAKE_CALL_SID = 'TEST_CALL_' + Date.now();

// Sample μ-law audio data (simulated speech with varying amplitude)
// Generate pseudo-random audio that looks like speech to VAD
function generateSpeechLikeAudio(): string {
  const buffer = Buffer.alloc(160);
  for (let i = 0; i < 160; i++) {
    // Create wave pattern with some randomness (simulates speech energy)
    const wave = Math.sin(i / 10) * 127;
    const noise = (Math.random() - 0.5) * 50;
    const sample = Math.floor(wave + noise + 128);
    buffer[i] = Math.max(0, Math.min(255, sample));
  }
  return buffer.toString('base64');
}

let receivedAudioFromAI = false;
let aiSpoke = false;

console.log('1️⃣  Connecting to Twilio stream endpoint...');
const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('✅ Connected to Twilio stream!\n');

  console.log('2️⃣  Sending "start" event (simulating call start)...');
  ws.send(JSON.stringify({
    event: 'start',
    streamSid: FAKE_STREAM_SID,
    start: {
      streamSid: FAKE_STREAM_SID,
      callSid: FAKE_CALL_SID,
      accountSid: 'TEST_ACCOUNT',
      customParameters: {}
    }
  }));

  setTimeout(() => {
    console.log('✅ Start event sent\n');

    console.log('3️⃣  Sending audio frames (simulating caller speaking)...');
    // Send 100 frames of "speech-like" audio to trigger VAD
    for (let i = 0; i < 100; i++) {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: FAKE_STREAM_SID,
        media: {
          track: 'inbound',
          chunk: i.toString(),
          timestamp: (Date.now() + i * 20).toString(),
          payload: generateSpeechLikeAudio()
        }
      }));
    }
    console.log('✅ Sent 100 audio frames (2 seconds of "speech")\n');

    console.log('4️⃣  Waiting for AI response...');
    console.log('   (Looking for outbound audio from OpenAI)\n');

  }, 1000);

  // Timeout test after 15 seconds
  setTimeout(() => {
    console.log('\n⏱️  Test timeout after 15 seconds\n');
    console.log('📊 Results:');
    console.log(`   - Received audio from AI: ${receivedAudioFromAI ? '✅ YES' : '❌ NO'}`);

    if (receivedAudioFromAI && aiSpoke) {
      console.log('\n🎉 SUCCESS! Full integration is working!');
      console.log('   Twilio → Server → OpenAI → Server → Twilio ✓');
      ws.close();
      process.exit(0);
    } else if (receivedAudioFromAI) {
      console.log('\n⚠️  PARTIAL SUCCESS: Audio flow works but no speech detected');
      ws.close();
      process.exit(0);
    } else {
      console.log('\n❌ FAIL: No audio received from AI');
      console.log('   Check server logs for errors');
      ws.close();
      process.exit(1);
    }
  }, 15000);
});

ws.on('message', (data: Buffer) => {
  try {
    const message = JSON.parse(data.toString());

    // Log ALL messages for debugging
    console.log('📥 Received message:', message.event || 'unknown');

    if (message.event === 'media' && message.media?.track === 'outbound') {
      if (!receivedAudioFromAI) {
        console.log('✅ First audio chunk received from OpenAI!');
        console.log(`   Track: ${message.media.track}`);
        console.log(`   Payload length: ${message.media.payload?.length || 0}\n`);
        receivedAudioFromAI = true;
      }
      aiSpoke = true;
    }
  } catch (error) {
    console.log('📥 Received non-JSON data:', data.toString().substring(0, 100));
  }
});

ws.on('error', (error: Error) => {
  console.error('❌ WebSocket error:', error.message);
  console.log('\n💡 Make sure the server is running: npm run dev');
  process.exit(1);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});
