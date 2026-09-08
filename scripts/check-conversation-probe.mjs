// Validate saved live-probe behavior, not just API success. Later input files
// replace earlier runs of the same scenario, retaining initial failures on disk.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const cases = new Map();
for (const file of process.argv.slice(2)) {
  for (const result of JSON.parse(fs.readFileSync(file, 'utf8')))
    cases.set(result.scenario, result);
}
assert(cases.size > 0, 'Pass at least one results.json');
for (const [name, result] of cases) {
  const events = result.events;
  assert(!events.some((e) => e.error), `${name}: API or scenario error`);
  const tools = events.flatMap((e) => e.tools || []);
  const spoken = events.filter((e) => e.role === 'erica' && e.text);
  assert.equal(
    tools.filter((t) => t.name === 'end_call').length,
    1,
    `${name}: must close exactly once`
  );
  assert(
    !spoken.at(-1).text.includes('?'),
    `${name}: farewell reopened conversation`
  );
  for (const e of events.filter((e) =>
    e.tools?.some((t) => t.name === 'end_call')
  )) {
    assert.equal(e.audioBytes, 0, `${name}: speech accompanied end_call`);
  }
  if (name === 'supplied-name' || name === 'new-contact-sequence') {
    const bookingIndex = events.findIndex((e) =>
      e.tools?.some((t) => t.name === 'book_appointment')
    );
    const approvalIndex = events.findIndex(
      (e) => e.role === 'caller' && e.text === 'Yes, please book that.'
    );
    assert(
      bookingIndex > approvalIndex && approvalIndex > 0,
      `${name}: booking before explicit final approval`
    );
    const readback = events
      .slice(0, approvalIndex)
      .filter((e) => e.role === 'erica')
      .at(-1).text;
    assert(
      /threading/i.test(readback) &&
        /September 11/i.test(readback) &&
        /1:00 PM/i.test(readback),
      `${name}: missing exact readback`
    );
    assert.equal(
      tools.filter((t) => t.name === 'book_appointment').length,
      1,
      `${name}: duplicate booking`
    );
    const nameQuestions = spoken.filter((e) =>
      /(?:what|may|could|can).{0,40}(?:your .*name|your name)/i.test(e.text)
    );
    assert.equal(
      nameQuestions.length,
      name === 'supplied-name' ? 0 : 1,
      `${name}: redundant or missing name collection`
    );
    if (name === 'new-contact-sequence') {
      const phone = events.findIndex(
        (e) =>
          e.role === 'erica' &&
          /number.*(?:calling|file)|calling.*number/i.test(e.text)
      );
      assert(
        phone >= 0 && phone < events.indexOf(nameQuestions[0]),
        'Phone confirmation must precede name collection'
      );
    }
  }
  if (name === 'message-goodbye' || name === 'uncertain-message') {
    assert.equal(
      tools.filter((t) => t.name === 'leave_message_for_owner').length,
      1,
      `${name}: message repeated`
    );
    if (name === 'message-goodbye')
      assert(
        !spoken.some((e) => e.text.includes('?')),
        'Message goodbye reopened'
      );
    else
      assert(
        spoken.some((e) => /couldn.t confirm|could not confirm/i.test(e.text)),
        'Uncertain delivery claimed success'
      );
  }
  if (name === 'retry-limit') {
    assert.equal(
      tools.filter((t) => t.name === 'suggest_availability').length,
      2,
      'Expected one availability retry'
    );
    assert(
      spoken.some((e) => /message/i.test(e.text)),
      'Missing available recovery route'
    );
    assert(
      !spoken.some((e) => /I can (?:connect|transfer)/i.test(e.text)),
      'Promised unavailable transfer'
    );
  }
  if (name === 'job-inquiry')
    assert(
      !spoken.some((e) => e.text.includes('?')),
      'Job pointer reopened conversation'
    );
  if (name === 'new-request-after-closer')
    assert(
      spoken.some((e) => /Friday/i.test(e.text)),
      'New request abandoned'
    );
  console.log(`PASS ${name} (${result.audioInput ? 'spoken' : 'text'} input)`);
}
