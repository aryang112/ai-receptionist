# One visit, several services

The requested behavior is to treat “brows and chin” as one visit by default. Erica should arrange the entire visit, summarize it once, and obtain one explicit approval before creating or changing anything. Existing nearby appointments on the same date are a likely visit, not permission to change them silently: the read-back must name every included service. Separate dates or clearly separated visits stay separate unless the caller selects them.

## Reuse Phorest first

Official Phorest documentation supports a full client service selection in [availability](https://developer.phorest.com/reference/checkappointmentavailability) and several serviceSchedules in one [booking request](https://developer.phorest.com/reference/createbooking). Extend the existing Phorest adapter to send the complete requested service list and preserve returned service/staff/start/end details. Avoid joining independent single-service slots in the model. Return at most three complete visit choices to Erica.

An exact catalog combo is one catalog service. A requested combination that is not an exact combo stays several services in one visit. Never add an unrequested treatment to use a cheaper/different bundle; for example, brow+lip+chin does not equal brow+chin. Preserve canonical service IDs, durations, prices, local/UTC normalization and existing calendar restrictions.

## One proposal and approval

Generalize the current immutable prepare/confirm boundary to a bounded list of appointment items, retaining the single-item form for compatibility. Store the complete old/new service, date and time details server-side and return one readable summary. Any correction invalidates the whole proposal. Do not let Erica write the first service while still choosing the next service's time.

Example booking: “I can book chin threading at 4:30 and brow threading at 4:45 on Monday as one visit. Shall I book both?”

Example reschedule: “Move both your brow and chin appointments from Monday afternoon to Tuesday at 3?” The actual read-back must use the verified returned sequence, not invent both services starting at the same instant.

Example cancellation: “Cancel both your brow and chin appointments on Monday?” One affirmative reply approves exactly that listed scope. If the caller says “just the chin,” replace the proposal with that one item.

For existing records, prefer verified provider grouping identifiers if their semantics can be established. Until then, group same-date adjacent appointments conservatively using real start/end times and an explicit small gap, then name all services in the confirmation. A date alone must not merge unrelated morning and evening bookings. Preserve a catalog combo as one appointment; do not split it into imagined component records.

## Changes and failure handling

Phorest documents [batch cancellation by appointment IDs](https://developer.phorest.com/reference/cancelappointments), and [booking-level cancellation](https://developer.phorest.com/reference/cancelbooking) when a reliable booking ID is known. Prefer those over separate cancellation requests once verified against this tenant. The current adapter does not retain group linkage for historical records, so do not infer bookingId from an unrelated group_booking_id field.

The documented [update endpoint](https://developer.phorest.com/reference/updateappointment) changes one appointment. Revalidate the entire proposed visit before the first move, then update the explicitly selected appointments with their current versions. Handle slots currently occupied by the visit itself; do not invent an intermediate appointment time to solve a cyclic swap. Offer a different sequence/time if a safe move order cannot be established.

The cited docs do not establish all-or-nothing guarantees for booking or batch cancellation. Verify every expected appointment after the write. Stop on a failed/uncertain result, report the verified partial state, and never retry or automatically undo a successful item. A fresh proposal/approval governs remaining recovery work. Do not say “both booked/moved/cancelled” unless both outcomes are verified.

## Natural conversation

Keep ordinary listening acknowledgments. Remove repeated process announcements by doing the visit work together and returning one useful result/question. Avoid a second permission question caused by an incomplete first read-back. Keep the current voice and interruption behavior; no voice-model or session-setting change is needed for this design.

## Validation before enabling grouped writes

Test two- and three-service requests, exact combos versus supersets, Sunday-to-next-working-day alternatives for the whole visit, capacity for only one requested service, same-day unrelated appointments, one-service-only cancellation, full-visit reschedule, stale availability/version conflict, partial writes and uncertain replies. Verify actual returned child records. Follow with owner calls for pacing, interruptions and perceived naturalness.

Status: design proposal only. The current enablement work connects existing single-appointment Live proposals to real Phorest writes and removes the direct-caller allowlist. It does not implement this grouped-visit behavior or claim its acceptance tests passed.
