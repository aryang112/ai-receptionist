// Test script to verify OpenAI Realtime API works
import { OpenAIRealtimeSession } from '../src/realtime/openaiSession.js';

console.log('🧪 Testing OpenAI Realtime API...\n');

let audioChunksReceived = 0;
let textReceived = '';

const session = new OpenAIRealtimeSession({
  onAudioChunk: (chunk) => {
    audioChunksReceived++;
    if (audioChunksReceived === 1) {
      console.log('✅ First audio chunk received!');
    }
  },
  onTextDelta: (delta) => {
    textReceived += delta;
    process.stdout.write(delta);
  },
  onResponseComplete: () => {
    console.log('\n✅ Response completed!');
    console.log(`\n📊 Summary:`);
    console.log(`   - Text received: "${textReceived}"`);
    console.log(`   - Audio chunks: ${audioChunksReceived}`);

    if (audioChunksReceived > 0) {
      console.log('\n🎉 SUCCESS! Audio is working!');
      process.exit(0);
    } else {
      console.log('\n❌ FAIL: No audio received!');
      process.exit(1);
    }
  },
  onError: (error) => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  },
});

async function test() {
  try {
    console.log('1️⃣  Connecting to OpenAI...');
    await session.connect();
    console.log('✅ Connected!\n');

    console.log('2️⃣  Configuring session...');
    await session.configureSession({
      instructions: 'You are a helpful assistant. Keep responses very short.',
      tools: [],
    });
    console.log('✅ Session configured!\n');

    console.log('3️⃣  Sending test message: "Say hello"\n');
    console.log('🤖 AI Response: ');
    await session.sendUserText('Say hello');

    // Timeout after 10 seconds
    setTimeout(() => {
      console.log('\n\n❌ TIMEOUT: No response after 10 seconds');
      console.log(`   - Text received: "${textReceived}"`);
      console.log(`   - Audio chunks: ${audioChunksReceived}`);
      process.exit(1);
    }, 10000);
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

test();
