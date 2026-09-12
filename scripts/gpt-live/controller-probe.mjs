// Real API + real read-only Phorest probe through the production call controller.
// A fake Twilio transport records paced audio and acknowledges marks; no phone is dialed.
import 'dotenv/config';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const model = process.env.PROBE_BACKEND || 'gpt-5.6-terra';
const phrase = process.env.PROBE_PHRASE || 'I want eyebrow threading and upper lip threading next Friday afternoon.';
const seconds = Number(process.env.PROBE_SECONDS || 40);
const engine = process.env.PROBE_ENGINE || 'live';
const output = process.env.PROBE_OUTPUT || `/tmp/erica-controller-${engine}-${model}-${Date.now()}`;
fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, { NODE_ENV: 'development', VOICE_ENGINE: engine, OPENAI_LIVE_BACKEND_MODEL: model,
  PHOREST_WRITE_MODE: 'simulate', OWNER_SMS_MODE: 'simulate', USE_MOCK_PHOREST: 'false', RECORD_CALLS: 'false',
  TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', WS_AUTH_SECRET: '', VOICE_TEST_ALLOWED_PHONES: '2025550198',
  CALL_STORE_PATH: path.join(output, 'calls.jsonl'), LOG_LEVEL: 'warn' });
const key = process.env.OPENAI_REALTIME_API_KEY || process.env.OPENAI_API_KEY;
const cache = `/tmp/erica-probe-${crypto.createHash('sha256').update(phrase).digest('hex').slice(0,12)}.ulaw`;
function encode(sample) { let sign = sample < 0 ? 128 : 0; let v = Math.min(32635, Math.abs(sample)) + 132; let exponent = 7; for (let mask = 16384; exponent > 0 && !(v & mask); exponent--, mask >>= 1) {} return ~(sign | exponent << 4 | ((v >> (exponent + 3)) & 15)) & 255; }
let caller;
if (fs.existsSync(cache)) caller = fs.readFileSync(cache);
else {
  const response = await fetch('https://api.openai.com/v1/audio/speech', { method:'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({model:'gpt-4o-mini-tts', voice:'alloy', input:phrase, response_format:'pcm'}) });
  if (!response.ok) throw new Error(`TTS failed: ${response.status}`);
  const pcm = Buffer.from(await response.arrayBuffer()); caller = Buffer.alloc(Math.floor(pcm.length/6));
  for (let i=0;i<caller.length;i++) caller[i]=encode(Math.round((pcm.readInt16LE(i*6)+pcm.readInt16LE(i*6+2)+pcm.readInt16LE(i*6+4))/3));
  fs.writeFileSync(cache, caller);
}
const { TwilioRealtimeCall } = await import('../../dist/realtime/twilioStream.js');
const { muLawRms } = await import('../../dist/voice/mulawAudio.js');
const frames=[]; const speech=[]; let call; let mediaClock=0; let speak=false; let silenceRun=0; let callerStartedAt; let callerEndedAt; const started=Date.now();
class Socket extends EventEmitter {
  readyState=1;
  send(raw) { const event=JSON.parse(raw); if(event.event==='media') { const b=Buffer.from(event.media.payload,'base64'); frames.push(b); if(muLawRms(b)>200) { silenceRun=0; if(!speak){speak=true;speech.push({startMs:Date.now()-started});} } else if(speak && ++silenceRun>=30){ speak=false; speech[speech.length-1].endMs=Date.now()-started;} }
    if(event.event==='mark') setTimeout(()=>this.emit('message',Buffer.from(JSON.stringify({event:'mark',mark:event.mark}))),20);
  }
  close(){this.readyState=3;this.emit('close',1000,Buffer.alloc(0));}
}
const socket=new Socket();call=new TwilioRealtimeCall(socket);
const callSid=`CA_probe_${Date.now()}`;
socket.emit('message',Buffer.from(JSON.stringify({event:'start',start:{streamSid:'MZ_probe',callSid,customParameters:{from:'+12025550198'}}})));
let index=0;
const timer=setInterval(()=>{
  if(socket.readyState!==1)return;
  let b=Buffer.alloc(160,255);
  // Allow a full greeting before the caller speaks; never replay input at >1x.
  if(Date.now()-started>10000 && index<caller.length){if(!callerStartedAt)callerStartedAt=Date.now()-started;caller.copy(b,0,index,index+160);index+=160;if(index>=caller.length)callerEndedAt=Date.now()-started;}
  mediaClock+=20; socket.emit('message',Buffer.from(JSON.stringify({event:'media',media:{timestamp:String(mediaClock),payload:b.toString('base64')}})));
},20);
await new Promise(r=>setTimeout(r,seconds*1000));clearInterval(timer);
socket.emit('message',Buffer.from(JSON.stringify({event:'stop'})));
await new Promise(r=>setTimeout(r,2200));
fs.writeFileSync(path.join(output,'output.ulaw'),Buffer.concat(frames));
const result={engine,model,phrase,callerStartedAt,callerEndedAt,speech,outputBytes:frames.reduce((n,b)=>n+b.length,0),output};
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
